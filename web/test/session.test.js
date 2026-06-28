// session.test.js — in-session re-show spacing + queue top-up (issue #2).
// These are pure-function tests; no FSRS state is mutated. Run with `npm test`.

import { describe, it, expect } from "vitest";
import {
  buildSession,
  topUp,
  pickRecycled,
  placement,
  RESHOW,
  SESSION_MIN_QUEUE,
  SESSION_HORIZON_MIN,
} from "../src/lib/session.js";

const now = new Date("2026-06-27T12:00:00Z");
// A synthetic FSRS-ish card whose only relevant field is `due`.
const dueIn = (mins) => ({ due: new Date(now.getTime() + mins * 60000) });
const noJitter = () => 0; // deterministic: place at the base gap

describe("placement", () => {
  it("graduates a card due beyond the session horizon", () => {
    const pl = placement(dueIn(SESSION_HORIZON_MIN + 1), 10, now, noJitter);
    expect(pl.graduates).toBe(true);
    expect(pl.reinsertAt).toBe(-1);
  });

  it("never reinserts at the front while another card remains (no back-to-back)", () => {
    // Most-overdue case (due within a minute), smallest possible gap.
    for (let queueLen = 1; queueLen <= 8; queueLen++) {
      const pl = placement(dueIn(0.5), queueLen, now, noJitter);
      expect(pl.graduates).toBe(false);
      expect(pl.reinsertAt).toBeGreaterThanOrEqual(1);
      expect(pl.reinsertAt).toBeLessThanOrEqual(queueLen);
    }
  });

  it("brings more-overdue cards back sooner than nearly-due ones (bias preserved)", () => {
    const big = 20; // plenty of room so the gap isn't clamped
    const overdue = placement(dueIn(0.5), big, now, noJitter).reinsertAt;
    const nearlyDue = placement(dueIn(SESSION_HORIZON_MIN - 1), big, now, noJitter).reinsertAt;
    expect(overdue).toBeGreaterThanOrEqual(RESHOW.minGap);
    expect(overdue).toBeLessThan(nearlyDue);
    expect(nearlyDue).toBeLessThanOrEqual(RESHOW.maxGap + RESHOW.jitter);
  });

  it("clamps the gap to the queue length on a short tail", () => {
    // Nearly-due wants a large gap, but only one other card is present.
    const pl = placement(dueIn(SESSION_HORIZON_MIN - 1), 1, now, noJitter);
    expect(pl.reinsertAt).toBe(1);
  });

  it("documents the irreducible case: a lone card (no others) reinserts at 0", () => {
    const pl = placement(dueIn(0.5), 0, now, noJitter);
    expect(pl.reinsertAt).toBe(0); // nothing to interleave with — unavoidable
  });
});

describe("topUp", () => {
  it("refills the queue from the reserve up to the minimum and reports what it added", () => {
    const { queue, reserve, added } = topUp(["s"], ["a", "b", "c", "d", "e"]);
    expect(queue.length).toBe(SESSION_MIN_QUEUE);
    expect(added).toEqual(["a", "b", "c"]); // SESSION_MIN_QUEUE (4) - 1
    expect(reserve).toEqual(["d", "e"]);
  });

  it("is a no-op when the queue already has enough cards", () => {
    const q = ["a", "b", "c", "d", "e"];
    const r = ["x"];
    const out = topUp(q, r);
    expect(out.queue).toBe(q);
    expect(out.reserve).toBe(r);
    expect(out.added).toEqual([]);
  });

  it("is a no-op when the reserve is empty", () => {
    const out = topUp(["s"], []);
    expect(out.added).toEqual([]);
    expect(out.queue).toEqual(["s"]);
  });

  it("adds only what the reserve can supply", () => {
    const { queue, reserve, added } = topUp(["s", "t"], ["a"]);
    expect(added).toEqual(["a"]);
    expect(queue).toEqual(["s", "t", "a"]);
    expect(reserve).toEqual([]);
  });
});

describe("pickRecycled", () => {
  const allCards = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  // a, b, c have been seen (have FSRS state); d is new.
  const seen = new Map([["a", { due: now }], ["b", { due: now }], ["c", { due: now }]]);

  it("returns only already-seen cards that aren't currently live", () => {
    const out = pickRecycled(allCards, seen, ["a"], 5);
    expect(out.sort()).toEqual(["b", "c"]); // a is live, d is unseen
  });

  it("never returns an unseen (new) card", () => {
    const out = pickRecycled(allCards, seen, [], 10);
    expect(out).not.toContain("d");
    expect(out.sort()).toEqual(["a", "b", "c"]);
  });

  it("caps the result at n", () => {
    const out = pickRecycled(allCards, seen, [], 2);
    expect(out.length).toBe(2);
    out.forEach((id) => expect(["a", "b", "c"]).toContain(id));
  });

  it("accepts a Set for liveIds", () => {
    expect(pickRecycled(allCards, seen, new Set(["b", "c"]), 5)).toEqual(["a"]);
  });

  it("returns [] when nothing is eligible or n <= 0", () => {
    expect(pickRecycled(allCards, seen, [], 0)).toEqual([]);
    expect(pickRecycled(allCards, seen, ["a", "b", "c"], 3)).toEqual([]); // all live
    expect(pickRecycled(allCards, new Map(), [], 3)).toEqual([]); // none seen
  });
});

describe("buildSession", () => {
  it("queues all due cards + a budget of new cards, and reserves the rest", () => {
    const allCards = [
      { id: "d1" }, { id: "d2" },
      { id: "f1" }, { id: "f2" }, { id: "f3" },
    ];
    const stateById = new Map([
      ["d1", dueIn(-10)], // due in the past → due now
      ["d2", dueIn(-5)],
    ]);
    const { queue, reserve } = buildSession(allCards, stateById, 2, now);

    expect(queue).toContain("d1");
    expect(queue).toContain("d2");
    expect(queue.length).toBe(4); // 2 due + 2 new (budget)
    expect(reserve.length).toBe(1); // the 1 new card beyond the budget

    // Every fresh card lands in exactly one of queue/reserve.
    const fresh = ["f1", "f2", "f3"];
    const placed = [...queue.filter((id) => fresh.includes(id)), ...reserve];
    expect(placed.sort()).toEqual(fresh);
  });
});

describe("regression: tail of a session never bunches the same card (issue #2)", () => {
  it("never shows a struggled card twice in a row while any other card remains", () => {
    // S is always due within a minute (relearning), so it never graduates.
    const sCard = dueIn(0.5);
    let queue = ["S", "a", "b"];
    let reserve = ["c", "d", "e", "f"];
    const shown = [];

    for (let i = 0; i < 50; i++) {
      const cur = queue[0];
      shown.push(cur);
      const rest = queue.slice(1);
      if (cur === "S") {
        const pl = placement(sCard, rest.length, now, noJitter);
        rest.splice(pl.reinsertAt, 0, "S"); // re-show; never graduates
      }
      // any other card is answered and graduates out of the session
      const t = topUp(rest, reserve);
      reserve = t.reserve;
      queue = t.queue;
      if (queue.length < 2) break; // only S left: the legitimate end of content
    }

    // While other cards were in play, S was never shown back-to-back...
    for (let i = 1; i < shown.length; i++) {
      if (shown[i] === "S") expect(shown[i - 1]).not.toBe("S");
    }
    // ...yet it still re-showed several times (the desirable extra practice).
    expect(shown.filter((x) => x === "S").length).toBeGreaterThan(1);
  });
});
