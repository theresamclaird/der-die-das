# Contributing to der · die · das

Thanks for your interest! **der · die · das** is a German noun-article trainer —
a mobile-first PWA with implicit, latency-based grading and FSRS spaced
repetition, live at **[artikelfuchs.com](https://artikelfuchs.com/)**. It's a
personal project with a single maintainer
([@theresamclaird](https://github.com/theresamclaird)), so contribution is
lightweight and issue-driven.

Please also read [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md). By participating you
agree to abide by it.

## Where to start

- **[`README.md`](./README.md)** — quick start.
- **[`CLAUDE.md`](./CLAUDE.md)** — architecture invariants and conventions (the
  canonical short list).
- **[`AGENTS.md`](./AGENTS.md)** — how AI agents may collaborate, the PR-review
  checklist, and the maintainer-only **deny-list**.
- **[`docs/`](./docs)** — `DESIGN.md` (what/why) and `IMPLEMENTATION_PLAN.md`
  (how/when). These are the source of truth.

## Ways to contribute

### File an issue

All work is issue-driven. Blank issues are disabled — pick a structured form:

- **🐛 Bug** — something's broken.
- **✨ Feature / change** — a new capability or a change in behavior.

Every required field on the form encodes the **definition of ready**: an issue is
only actionable once the goal, acceptance criteria, affected area, and risk level
are filled in. Fill them all — it's what lets the issue be picked up.

### Open a pull request

1. **Start from an issue.** Comment on it so the maintainer knows it's being
   worked on. For anything non-trivial, agree on the approach before writing code.
2. **Branch from `main`.** Use a descriptive name, e.g. `fix/issue-12-card-width`
   or `docs/issue-15-contributing`.
3. **Keep the PR focused.** Do only what the issue asks — flag or split unrelated
   drive-by changes.
4. **Fill in the PR template** (it appears automatically) and link the issue with
   `Closes #<n>`.

## Development

Everything for the app lives in [`web/`](./web):

```bash
cd web
npm install
npm run dev      # http://localhost:5173
npm test         # Vitest unit tests
npm run build    # production PWA build
```

Content data is regenerated in [`pipeline/`](./pipeline), never hand-edited in
`web/src/data/nouns.json`:

```bash
cd pipeline
pip install german-nouns
python build_nouns.py            # writes out/nouns.json
cp out/nouns.json ../web/src/data/nouns.json
```

## Conventions

- **Language:** ES modules, plain JSX for the app. TypeScript is used **only**
  under `web/amplify/`.
- **Style:** no linter/formatter is configured yet — match the surrounding file's
  existing style (quoting, indentation, naming) rather than introducing a new
  convention. Proposing ESLint/Prettier is welcome, but as its own issue, not
  smuggled into an unrelated change.
- **Tests:** pure logic (inference, scheduling helpers) stays unit-testable with
  Vitest. Add or extend tests alongside any logic change, and make sure
  `npm test` passes before opening a PR.
- **Secrets:** never commit `amplify_outputs.json` / `amplify_outputs.*` /
  `.amplify` — they're gitignored for a reason.

## Architecture invariants (don't break these)

These keep the engine swappable and the data forward-compatible. See `CLAUDE.md`
and `AGENTS.md` for the full rationale:

- `web/src/lib/scheduler.js` is the **only** file that imports `ts-fsrs`.
- `web/src/lib/inference.js` (implicit/latency grading) is **pure and
  framework-free**, tuned only via its exported `TUNING` constants — which are
  calibrated from real logged data, not guessed.
- `web/src/lib/db.js` is dependency-free IndexedDB with an **append-only** review
  log — never drop or rename log fields.
- New content types (verbs, plurals, grammar) are new `type` values that **reuse**
  the same scheduler / inference / db — don't couple the engine to "noun".

## Maintainer-only areas (deny-list)

Some areas always require the maintainer and should **not** be changed in a
community or agent PR without prior agreement. Changes here get extra scrutiny:

- **IndexedDB schema or migrations** (`web/src/lib/db.js` shape, stores, indexes,
  versioning).
- **FSRS grading logic** (`web/src/lib/scheduler.js` and how grades/due dates are
  derived).
- **DynamoDB / Amplify sync** and anything crossing the local ↔ cloud boundary
  (`web/src/lib/sync.js`, `web/src/lib/amplifyAdapter.js`,
  `web/src/lib/amplifyConfig.js`, `web/amplify/**`).
- **Secrets / auth** (`web/src/Auth.jsx`, Cognito config, `amplify_outputs.*`, any
  credential).

When in doubt about whether something is deny-listed, treat it as deny-listed and
ask first.

## A note on AI agents

This repo actively uses AI agents to help with triage and review. If you're
configuring or running an agent against it, [`AGENTS.md`](./AGENTS.md) is the
source of truth for what agents are — and are not — allowed to do.

## Questions

Not sure about something? Open an issue (or comment on an existing one) and ask.
Thanks for contributing! 🇩🇪
