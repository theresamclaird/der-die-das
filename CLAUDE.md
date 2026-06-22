# der · die · das — project guide

German noun-article trainer. Mobile-first PWA with implicit, latency-based
grading and FSRS scheduling. Personal project (single user); see
`docs/DESIGN.md` for the full design and `docs/IMPLEMENTATION_PLAN.md` for phasing.

## Layout
- `docs/` — DESIGN.md (what/why) and IMPLEMENTATION_PLAN.md (how/when). Source of truth.
- `pipeline/` — Python content pipeline. Joins a leveled lemma list against
  `german-nouns` to emit `web/src/data/nouns.json`. Run with `python build_nouns.py`.
- `web/` — the Vite + React PWA. `npm install && npm run dev`.

## web/ architecture invariants (keep these true)
- `src/lib/scheduler.js` is the **only** file that imports `ts-fsrs`. Swapping
  schedulers should touch nothing else.
- `src/lib/inference.js` (implicit grading, DESIGN §4.6) is framework-free and
  unit-tested. Keep it pure; tune via the exported `TUNING` constants.
- `src/lib/db.js` is dependency-free IndexedDB: card state + append-only review
  log + meta. The log shape is intended for later DynamoDB sync — don't drop fields.
- `src/lib/session.js` decides in-session re-show vs. graduate from the FSRS due date.
- New content types (verbs, plurals, grammar) are new `type` values sharing the
  same scheduler/inference/db — do not couple the engine to "noun".

## Conventions
- Tuning constants in `inference.js` are calibrated from real logged data, not guessed.
- Content is regenerated in `pipeline/`, never hand-edited in `nouns.json`.
- Status: Phase 0 complete (local PWA). Phase 1 = Cognito + DynamoDB sync.

## Commands
- `cd web && npm install` — install
- `npm run dev` / `npm test` / `npm run build`
- `cd pipeline && python build_nouns.py` — regenerate content
