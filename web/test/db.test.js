// db.test.js — regression guard for the IndexedDB open() resilience added for
// issue #12. iOS Safari can fire neither `success` nor `error` on the first
// open() after a reload; openDB() must time out, retry, eventually succeed, and
// reject cleanly once retries are exhausted (so the UI shows a recoverable error
// instead of hanging on "Loading…" forever).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Store } from "../src/lib/db.js";

// Must match the constants in db.js.
const OPEN_TIMEOUT_MS = 500;
const OPEN_RETRIES = 4;

function makeReq() {
  return { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, result: null, error: null };
}

let savedIDB;

beforeEach(() => {
  savedIDB = globalThis.indexedDB;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.indexedDB = savedIDB;
});

describe("Store.open() resilience (issue #12)", () => {
  it("retries when open() hangs, then resolves once a later attempt succeeds", async () => {
    const reqs = [];
    let succeedOn = 3; // the 3rd open() (after two hung attempts) fires success
    globalThis.indexedDB = {
      open: () => {
        const r = makeReq();
        reqs.push(r);
        if (reqs.length === succeedOn) {
          // Fire success out-of-band, like the browser would.
          queueMicrotask(() => { r.result = { fake: "db" }; r.onsuccess?.(); });
        }
        return r;
      },
    };

    const p = Store.open();
    // Two hung attempts → two timeouts → third attempt succeeds.
    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS);

    const store = await p;
    expect(store).toBeInstanceOf(Store);
    expect(store.db).toEqual({ fake: "db" });
    expect(reqs.length).toBe(succeedOn);
  });

  it("rejects with a timeout error once all retries are exhausted", async () => {
    let calls = 0;
    globalThis.indexedDB = {
      open: () => { calls++; return makeReq(); }, // every attempt hangs
    };

    const p = Store.open();
    // Attach the rejection expectation before advancing so the rejection is handled.
    const assertion = expect(p).rejects.toThrow("IndexedDB open timed out");
    // attempts 0..OPEN_RETRIES each burn one timeout before the final reject.
    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS * (OPEN_RETRIES + 1));
    await assertion;
    expect(calls).toBe(OPEN_RETRIES + 1);
  });

  it("closes an orphaned connection if a hung attempt resolves after we moved on", async () => {
    const closes = [];
    const reqs = [];
    let succeedOn = 2;
    globalThis.indexedDB = {
      open: () => {
        const r = makeReq();
        reqs.push(r);
        if (reqs.length === succeedOn) {
          queueMicrotask(() => { r.result = { fake: "db" }; r.onsuccess?.(); });
        }
        return r;
      },
    };

    const p = Store.open();
    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS); // abandon attempt 0, retry → attempt 1 succeeds
    await p;

    // Now the original (attempt 0) request belatedly resolves with a real handle:
    // openDB must close it rather than leak it.
    const orphan = reqs[0];
    orphan.result = { close: () => closes.push("closed") };
    orphan.onsuccess?.();
    expect(closes).toEqual(["closed"]);
  });
});
