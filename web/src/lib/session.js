// session.js — builds and advances a study session (DESIGN §7).
// Due cards + a budget of new cards form the queue. In-session re-show vs.
// graduation is decided by the real ts-fsrs due date: if a card is next due
// within SESSION_HORIZON it stays in this session, otherwise it leaves.

import { isDue, minutesUntilDue, emptyCard } from "./scheduler.js";

export const SESSION_HORIZON_MIN = 20; // cards due within 20 min re-show now

// Keep at least this many cards live in the queue while unintroduced cards
// remain, so a learning card always has others to interleave with instead of
// repeating back-to-back at the tail of a session (issue #2).
export const SESSION_MIN_QUEUE = 4;

// In-session re-show spacing. A learning card is reinserted *behind* other cards
// rather than at the front, so it can't be shown twice in a row. The gap scales
// with how soon the card is due — the more overdue, the sooner it returns (seen
// more often) — with light jitter so the cadence feels shuffled, not metronomic.
export const RESHOW = {
  minGap: 2, // most-overdue cards: at least this many other cards before re-show
  maxGap: 6, // nearly-due cards (~horizon): spread this far back
  jitter: 1, // add 0..jitter random slots so re-shows don't land on a fixed cadence
};

// Build a session: an ordered live `queue` of card ids plus a `reserve` of
// not-yet-introduced new cards. Due cards (+ a budget of new cards) form the
// queue; any new cards beyond the budget go to the reserve and are introduced
// later by topUp() to keep variety as the queue drains (issue #2).
// allCards: array of content cards (must have .id)
// stateById: Map id -> fsrs card (absent = new)
export function buildSession(allCards, stateById, newPerSession, now = new Date()) {
  const due = [];
  const fresh = [];
  for (const c of allCards) {
    const st = stateById.get(c.id);
    if (!st) fresh.push(c.id);
    else if (isDue(st, now)) due.push(c.id);
  }
  shuffle(due);
  shuffle(fresh);
  return {
    queue: [...due, ...fresh.slice(0, newPerSession)],
    reserve: fresh.slice(newPerSession),
  };
}

// Top the live queue back up from the reserve when it runs low, so re-shown
// cards keep interleaving with fresh ones instead of bunching at the tail.
// Pure: returns new arrays + the ids `added` (so callers can update counts).
// No-op once the reserve is empty — then the caller falls back to pickRecycled.
export function topUp(queue, reserve, minQueue = SESSION_MIN_QUEUE) {
  if (queue.length >= minQueue || reserve.length === 0) {
    return { queue, reserve, added: [] };
  }
  const need = minQueue - queue.length;
  const added = reserve.slice(0, need);
  return { queue: [...queue, ...added], reserve: reserve.slice(need), added };
}

// Pick up to `n` already-seen cards (those with FSRS state) that aren't already
// live in the queue, to interleave as OFF-SCHEDULE filler when no new cards are
// left — e.g. a review session of a level you've finished learning, where the
// reserve is empty but a struggled card still needs other cards between re-shows
// (issue #2). The caller shows these without grading them. `rng` is injectable
// for deterministic tests.
export function pickRecycled(allCards, stateById, liveIds, n, rng = Math.random) {
  if (n <= 0) return [];
  const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
  const pool = [];
  for (const c of allCards) {
    if (!live.has(c.id) && stateById.get(c.id)) pool.push(c.id);
  }
  shuffle(pool, rng);
  return pool.slice(0, n);
}

// Whether a card has moved past the in-session horizon and should leave the
// session (vs. re-show as a learning step). Pulled out so callers that only need
// the yes/no don't have to invoke placement() — which would consume an rng draw.
export function willGraduate(fsrsCard, now = new Date()) {
  return minutesUntilDue(fsrsCard, now) > SESSION_HORIZON_MIN;
}

// Decide what to do with a card after it's been answered.
// Returns { graduates: boolean, reinsertAt: number }.
// `rng` is injectable for deterministic tests; defaults to Math.random.
export function placement(fsrsCard, queueLen, now = new Date(), rng = Math.random) {
  if (willGraduate(fsrsCard, now)) return { graduates: true, reinsertAt: -1 };
  const mins = minutesUntilDue(fsrsCard, now);

  // Soonest-due cards come back after the smallest gap; the gap grows toward the
  // horizon. Always behind >= minGap other cards (+ jitter), then clamped to the
  // queue length so a short tail can't collapse the gap into a back-to-back
  // repeat: with >= 1 other card present, reinsertAt is >= 1 (never the front).
  const frac = Math.max(0, Math.min(1, mins / SESSION_HORIZON_MIN));
  const baseGap = RESHOW.minGap + Math.round(frac * (RESHOW.maxGap - RESHOW.minGap));
  const desired = baseGap + Math.floor(rng() * (RESHOW.jitter + 1));
  return { graduates: false, reinsertAt: Math.min(queueLen, desired) };
}

// Weight a seen card for cram ordering: harder (higher FSRS difficulty) and
// more-lapsed cards get a heavier weight, so they tend to come up earlier.
// Tunable; difficulty defaults to a neutral mid-value if somehow unset.
export const CRAM_WEIGHT = { lapseBoost: 2 };
function cramWeight(st) {
  const difficulty = st.difficulty ?? 5; // FSRS difficulty ~1..10
  const lapses = st.lapses ?? 0;
  return 1 + difficulty + CRAM_WEIGHT.lapseBoost * lapses;
}

// Cram queue: every introduced (seen) card in the pool, ignoring due dates.
// Ordered by a *weighted* shuffle (Efraimidis–Spirakis): each card draws a key
// random^(1/weight) and we sort by key descending. That yields a fresh random
// order every round, biased so the shaky words surface earlier on average —
// variety + targeting, instead of either a fixed list or a flat shuffle.
// Read-only re: FSRS — never mutates state.
export function buildCramQueue(allCards, stateById) {
  const scored = [];
  for (const c of allCards) {
    const st = stateById.get(c.id);
    if (!st) continue;
    const key = Math.random() ** (1 / cramWeight(st));
    scored.push({ id: c.id, key });
  }
  scored.sort((a, b) => b.key - a.key);
  return scored.map((x) => x.id);
}

// Maintain variety in the live queue: pull new cards from the reserve first,
// then recycle already-seen cards as off-schedule filler, up to `minQueue`.
// `exclude` lists ids that must NOT be recycled (e.g. the card we're about to
// re-insert, or the one that just left — so it can't reappear as its own filler).
// Pure: returns new arrays + an updated filler Set + count of NEW cards added.
function variety(queue, reserve, filler, allCards, stateById, minQueue, rng, exclude) {
  const t = topUp(queue, reserve, minQueue);
  let q = t.queue;
  const nextFiller = new Set(filler);
  if (q.length < minQueue) {
    const live = new Set([...q, ...(exclude || [])]);
    const recycled = pickRecycled(allCards, stateById, live, minQueue - q.length, rng);
    recycled.forEach((id) => nextFiller.add(id));
    q = [...q, ...recycled];
  }
  return { queue: q, reserve: t.reserve, filler: nextFiller, addedNew: t.added.length };
}

// Compute the next session queue after a card is answered (issue #2). Pure — all
// state is passed in and new values returned, so it's unit-testable without React.
//   rest:      the queue with the answered card already removed (it was index 0)
//   answered:  { id, stays } — stays=false means it graduated or was off-schedule
//              filler (it leaves); stays=true means it's a learning step to re-show
//   fsrsCard:  the answered card's FSRS state, used for re-show spacing when it stays
//   reserve:   unintroduced new-card ids
//   filler:    Set of ids currently in the queue as off-schedule recycled filler
//   allCards / stateById: the active pool + FSRS states (for recycling)
// Returns { queue, reserve, filler, addedNew }.
export function advanceQueue({
  rest, answered, fsrsCard, reserve, filler,
  allCards, stateById, now = new Date(), rng = Math.random, minQueue = SESSION_MIN_QUEUE,
}) {
  const baseFiller = new Set(filler);
  baseFiller.delete(answered.id); // whatever it was, it's no longer live in `rest`

  if (!answered.stays) {
    // The card leaves. End the session only when nothing real is left to show:
    // no real cards in the queue AND no new cards in the reserve. (Filler implies
    // an empty reserve today, since variety() drains the reserve via topUp before
    // recycling — but guarding on reserve too keeps a future call-order change
    // from silently ending a session while fresh cards still wait in the reserve.)
    const realLeft = rest.filter((id) => !baseFiller.has(id)).length;
    if (realLeft === 0 && reserve.length === 0) {
      return { queue: [], reserve, filler: new Set(), addedNew: 0 };
    }
    return variety(rest, reserve, baseFiller, allCards, stateById, minQueue, rng, [answered.id]);
  }

  // The card stays (learning step). Bring in variety FIRST so new/filler cards
  // can sit *before* a lone re-shown card, then place it behind a gap computed
  // against the topped-up queue — never at the front while others exist (#2).
  const v = variety(rest, reserve, baseFiller, allCards, stateById, minQueue, rng, [answered.id]);
  const { reinsertAt } = placement(fsrsCard, v.queue.length, now, rng);
  const queue = [...v.queue];
  queue.splice(reinsertAt, 0, answered.id);
  return { queue, reserve: v.reserve, filler: v.filler, addedNew: v.addedNew };
}

export function ensureState(stateById, id) {
  let st = stateById.get(id);
  if (!st) {
    st = emptyCard();
    stateById.set(id, st);
  }
  return st;
}

function shuffle(a, rng = Math.random) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
