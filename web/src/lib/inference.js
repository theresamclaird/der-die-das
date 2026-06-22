// inference.js — the implicit-grading layer (DESIGN §4.6).
// Pure functions, no framework or DOM, so they're unit-testable. This is the
// custom part of the system: a single committed tap becomes Again/Hard/Good/Easy
// from correctness + normalized response latency.

import { RATING } from "./scheduler.js";

// Tuning constants. These are meant to be calibrated from your own logged data
// after real use — not trusted blindly. See README "Calibration".
export const TUNING = {
  READ_BASE: 220, // ms of perception before recall can begin
  READ_PER_CHAR: 45, // ms reading allowance per character of the lemma
  OUTLIER_MS: 12000, // beyond this, treat as distraction and discard timing
  EASY_RATIO: 0.6, // recall < 0.6× baseline → Easy
  HARD_RATIO: 1.4, // recall > 1.4× baseline → Hard
  BASELINE_WINDOW: 12, // how many recent recall times define "your norm"
};

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Rolling baseline of recall times (the denominator for normalization).
export class Baseline {
  constructor(window = TUNING.BASELINE_WINDOW, seed = []) {
    this.window = window;
    this.samples = seed.slice(-window);
  }
  push(recallMs) {
    this.samples.push(recallMs);
    if (this.samples.length > this.window) this.samples.shift();
  }
  value() {
    return median(this.samples);
  }
}

/**
 * Infer an FSRS rating from a single committed answer.
 * @param {object} a
 * @param {boolean} a.correct  did the tapped article match
 * @param {number}  a.latencyMs card-shown → tap
 * @param {number}  a.lemmaLen  characters in the noun (reading-time allowance)
 * @param {number|null} a.baseline rolling median recall ms, or null if not yet established
 * @param {boolean} a.hidden    was the tab hidden during the question (distraction)
 * @returns {{rating:number, recallMs:number|null, discarded:boolean, why:string, ratio?:number}}
 */
export function inferRating({ correct, latencyMs, lemmaLen, baseline, hidden }, t = TUNING) {
  if (!correct) {
    return { rating: RATING.Again, recallMs: null, discarded: false, why: "wrong answer" };
  }

  const readAllow = t.READ_BASE + t.READ_PER_CHAR * lemmaLen;
  const recallMs = Math.max(0, latencyMs - readAllow);

  // Outliers are clipped, not scored (DESIGN §4.6): don't punish distraction.
  if (hidden || latencyMs > t.OUTLIER_MS) {
    return { rating: RATING.Good, recallMs, discarded: true, why: "timing discarded (distraction) → default Good" };
  }

  // Until a personal baseline exists, fall back to absolute thresholds.
  if (baseline == null) {
    if (recallMs < 500) return { rating: RATING.Easy, recallMs, discarded: false, why: "fast — no baseline yet" };
    if (recallMs < 1500) return { rating: RATING.Good, recallMs, discarded: false, why: "ok — no baseline yet" };
    return { rating: RATING.Hard, recallMs, discarded: false, why: "slow — no baseline yet" };
  }

  const ratio = recallMs / baseline;
  const tag = `${ratio.toFixed(2)}× your norm`;
  if (ratio < t.EASY_RATIO) return { rating: RATING.Easy, recallMs, discarded: false, why: `fast — ${tag}`, ratio };
  if (ratio <= t.HARD_RATIO) return { rating: RATING.Good, recallMs, discarded: false, why: `normal — ${tag}`, ratio };
  return { rating: RATING.Hard, recallMs, discarded: false, why: `slow — ${tag}`, ratio };
}
