// session.js — builds and advances a study session (DESIGN §7).
// Due cards + a budget of new cards form the queue. In-session re-show vs.
// graduation is decided by the real ts-fsrs due date: if a card is next due
// within SESSION_HORIZON it stays in this session, otherwise it leaves.

import { isDue, minutesUntilDue, emptyCard } from "./scheduler.js";

export const SESSION_HORIZON_MIN = 20; // cards due within 20 min re-show now

// Build an ordered queue of card ids for a session.
// allCards: array of content cards (must have .id)
// stateById: Map id -> fsrs card (absent = new)
export function buildQueue(allCards, stateById, newPerSession, now = new Date()) {
  const due = [];
  const fresh = [];
  for (const c of allCards) {
    const st = stateById.get(c.id);
    if (!st) fresh.push(c.id);
    else if (isDue(st, now)) due.push(c.id);
  }
  shuffle(due);
  shuffle(fresh);
  return [...due, ...fresh.slice(0, newPerSession)];
}

// Decide what to do with a card after it's been answered.
// Returns { graduates: boolean, reinsertAt: number }.
export function placement(fsrsCard, queueLen, now = new Date()) {
  const mins = minutesUntilDue(fsrsCard, now);
  if (mins <= SESSION_HORIZON_MIN) {
    // learning/relearning step: bring it back, sooner the more overdue
    const pos = mins <= 1 ? 2 : Math.min(queueLen, 5);
    return { graduates: false, reinsertAt: Math.min(queueLen, pos) };
  }
  return { graduates: true, reinsertAt: -1 };
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

export function ensureState(stateById, id) {
  let st = stateById.get(id);
  if (!st) {
    st = emptyCard();
    stateById.set(id, st);
  }
  return st;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
