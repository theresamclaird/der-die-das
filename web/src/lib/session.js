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
