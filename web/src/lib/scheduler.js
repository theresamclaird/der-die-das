// scheduler.js — thin wrapper over ts-fsrs (DESIGN §4.2).
// Isolates the library so the rest of the app speaks a small, stable vocabulary:
// emptyCard(), applyRating(), isDue(), previewIntervals(). Swapping schedulers
// later means changing only this file.

import {
  fsrs,
  generatorParameters,
  createEmptyCard,
  Rating,
  State,
} from "ts-fsrs";

// request_retention 0.9 → intervals target ~90% recall probability.
// Default learning steps stay enabled, which gives short in-session re-shows
// for cards rated Again/Hard without any custom queue logic.
const params = generatorParameters({
  request_retention: 0.9,
  enable_fuzz: true,
});
const engine = fsrs(params);

// Re-export the rating values the inference layer produces.
// (ts-fsrs: Again=1, Hard=2, Good=3, Easy=4)
export const RATING = {
  Again: Rating.Again,
  Hard: Rating.Hard,
  Good: Rating.Good,
  Easy: Rating.Easy,
};
export const RATING_NAME = { [Rating.Again]: "Again", [Rating.Hard]: "Hard", [Rating.Good]: "Good", [Rating.Easy]: "Easy" };
export { State };

export function emptyCard(now = new Date()) {
  return createEmptyCard(now);
}

// Apply a rating to a card. Returns { card, log } — `card` is the new FSRS
// state to persist, `log` is the review-log record.
export function applyRating(card, rating, now = new Date()) {
  const out = engine.repeat(card, now)[rating];
  return { card: out.card, log: out.log };
}

export function isDue(card, now = new Date()) {
  return new Date(card.due).getTime() <= now.getTime();
}

// Minutes until a card is next due (used to decide in-session re-show vs graduate).
export function minutesUntilDue(card, now = new Date()) {
  return (new Date(card.due).getTime() - now.getTime()) / 60000;
}

// Preview the four possible next-due dates without committing (for UI display).
export function previewIntervals(card, now = new Date()) {
  const r = engine.repeat(card, now);
  return {
    [Rating.Again]: r[Rating.Again].card.due,
    [Rating.Hard]: r[Rating.Hard].card.due,
    [Rating.Good]: r[Rating.Good].card.due,
    [Rating.Easy]: r[Rating.Easy].card.due,
  };
}
