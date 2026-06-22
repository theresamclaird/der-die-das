// inference.test.js — tests for the implicit-grading layer (IMPLEMENTATION_PLAN
// "Testing strategy"). Run with `npm test`.

import { describe, it, expect } from "vitest";
import { inferRating, median, Baseline, TUNING } from "../src/lib/inference.js";
import { RATING } from "../src/lib/scheduler.js";

const base = 900; // a settled baseline recall time (ms)

describe("inferRating", () => {
  it("maps a wrong answer to Again regardless of speed", () => {
    expect(inferRating({ correct: false, latencyMs: 400, lemmaLen: 4, baseline: base }).rating).toBe(RATING.Again);
  });

  it("maps a fast correct answer to Easy", () => {
    const r = inferRating({ correct: true, latencyMs: 600, lemmaLen: 4, baseline: base });
    expect(r.rating).toBe(RATING.Easy);
  });

  it("maps a normal-paced correct answer to Good", () => {
    const r = inferRating({ correct: true, latencyMs: 1300, lemmaLen: 4, baseline: base });
    expect(r.rating).toBe(RATING.Good);
  });

  it("maps a slow correct answer to Hard", () => {
    const r = inferRating({ correct: true, latencyMs: 3500, lemmaLen: 4, baseline: base });
    expect(r.rating).toBe(RATING.Hard);
  });

  it("normalizes for word length: a long word read slower is still Good, not Hard", () => {
    // 14-char word; extra reading time should be subtracted out
    const short = inferRating({ correct: true, latencyMs: 1300, lemmaLen: 4, baseline: base });
    const long = inferRating({ correct: true, latencyMs: 1300 + (14 - 4) * TUNING.READ_PER_CHAR, lemmaLen: 14, baseline: base });
    expect(long.rating).toBe(short.rating); // same recall component → same grade
    expect(long.rating).toBe(RATING.Good);
  });

  it("discards outlier timing (distraction) and does not punish it", () => {
    const r = inferRating({ correct: true, latencyMs: 30000, lemmaLen: 4, baseline: base });
    expect(r.discarded).toBe(true);
    expect(r.rating).toBe(RATING.Good); // default, not Hard
  });

  it("discards timing when the tab was hidden", () => {
    const r = inferRating({ correct: true, latencyMs: 2000, lemmaLen: 4, baseline: base, hidden: true });
    expect(r.discarded).toBe(true);
  });

  it("falls back to absolute thresholds when no baseline exists", () => {
    const fast = inferRating({ correct: true, latencyMs: 500, lemmaLen: 4, baseline: null });
    const slow = inferRating({ correct: true, latencyMs: 3000, lemmaLen: 4, baseline: null });
    expect(fast.rating).toBe(RATING.Easy);
    expect(slow.rating).toBe(RATING.Hard);
  });
});

describe("median + Baseline", () => {
  it("computes median for odd and even lengths", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(null);
  });

  it("keeps only the most recent window of samples", () => {
    const b = new Baseline(3);
    [100, 200, 300, 400].forEach((x) => b.push(x));
    expect(b.samples).toEqual([200, 300, 400]);
    expect(b.value()).toBe(300);
  });
});
