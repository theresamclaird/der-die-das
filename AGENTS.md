# AGENTS.md — how AI agents collaborate on this repo

Guidance for AI agents (and the humans configuring them) working on **der · die · das**.
This complements the project guide in [`CLAUDE.md`](./CLAUDE.md) and the design docs in
[`docs/`](./docs) — those remain the source of truth for *what* the app is and *why*.
This file is the source of truth for *how agents are allowed to help*.

## Current stage — read this first

This is the **earliest, safest** stage of agent collaboration. Single maintainer
(`@theresamclaird`); agents assist.

**Agents MAY:** triage issues (labels, status comments, requests for missing info) and
review pull requests (comments / reviews tuned for high recall).

**Agents MUST NOT (yet):** write or modify code, open implementation PRs, push commits,
or merge anything. The CI workflows enforce this with `permissions: contents: read` — the
hard boundary is the GitHub token, not just instructions. Do not try to work around it.

Write access for agents is a deliberate *later* stage. Until then, the answer to "should I
just make the change?" is **no — propose it in a comment**.

## Stack & key invariants

Vite + React 18 (`.jsx`) PWA · `ts-fsrs` scheduling · Vitest tests · AWS Amplify Gen 2
(Cognito + DynamoDB) for sync. TypeScript is used **only** under `web/amplify/`; the app is
plain JSX.

Invariants that must stay true (see `CLAUDE.md` for the canonical list):

- **`web/src/lib/scheduler.js` is the only file that imports `ts-fsrs`.** Scheduler swaps
  touch nothing else.
- **`web/src/lib/inference.js` (implicit/latency grading) is pure and framework-free**, unit
  tested, tuned only via its exported `TUNING` constants — which are **calibrated from real
  logged data, not guessed**.
- **`web/src/lib/db.js` is dependency-free IndexedDB**: card state + **append-only** review
  log + meta. The log shape is forward-designed for DynamoDB sync — **never drop or rename
  log fields**.
- **`web/src/lib/session.js`** decides in-session re-show vs. graduate from the FSRS due date.
- New content types (verbs, plurals, grammar) are new `type` values that **reuse** the same
  scheduler / inference / db — do not couple the engine to "noun".
- Content is regenerated in `pipeline/` and **never hand-edited** in `web/src/data/nouns.json`.

## Conventions (inferred from the repo — confirm with the maintainer where unsure)

- **Language:** ES modules, plain JSX for the app; `.ts` only in `web/amplify/`.
- **Tests:** Vitest (`cd web && npm test`). Pure logic (inference, scheduling helpers) should
  stay unit-testable; add/extend tests alongside any logic change.
- **No linter/formatter is configured yet.** Match the surrounding file's existing style
  (quoting, indentation, naming) rather than introducing a new convention. If you think the
  repo needs ESLint/Prettier, that's its own issue — don't smuggle it into an unrelated change.
- **Secrets:** `amplify_outputs.json` / `amplify_outputs.*` / `.amplify` are gitignored and
  must never be committed.

## Definition of Ready (an issue is actionable only when…)

- [ ] **Problem/goal** is stated clearly (the need, not just a solution).
- [ ] **Acceptance criteria** are concrete and testable.
- [ ] **Affected area/surface** is identified (scheduler / inference / db / session / sync /
      UI / pipeline / content / docs / tooling).
- [ ] **Risk level** is set (low / med / high).
- [ ] **Agent-eligibility** is marked — and it does **not** fall in the deny-list below.

The issue forms in `.github/ISSUE_TEMPLATE/` collect all of these. Triage should comment
asking for any missing field before the issue is considered ready.

## PR-review checklist (tuned for HIGH RECALL)

Bias toward flagging. **If something is even slightly concerning, raise it** — a false alarm
costs a sentence; a missed regression in the data or scheduling layer costs real review data.
Mark each finding with severity (🔴 blocker / 🟡 concern / 🟢 nit) and say plainly when you're
unsure. Prefer surfacing a maybe over staying silent.

Check, in priority order:

1. **Deny-list touch (🔴 always):** Does the diff touch IndexedDB schema/migrations, FSRS
   grading logic, DynamoDB/Amplify sync, or secrets? If so, flag prominently and state that
   maintainer review is **required** — regardless of how clean the change looks.
2. **Data layer integrity:** Any change to `db.js` shape, the review-log fields, or key/index
   structure? Is the log still append-only? Is there a migration path for existing IndexedDB
   data? Could existing users lose or corrupt state?
3. **Scheduling correctness:** Does `ts-fsrs` stay isolated to `scheduler.js`? Are grades,
   due dates, or stability/difficulty handled correctly? Any off-by-one or timezone issues in
   due-date math?
4. **Inference purity & tuning:** Is `inference.js` still pure and framework-free? Were
   `TUNING` constants changed — and if so, are they justified by logged data rather than guessed?
5. **Sync boundary:** Does anything cross the local-first → DynamoDB boundary in a way that
   could lose writes, double-apply, or leak data between users?
6. **Tests:** Is logic covered? Do existing tests still pass? Should a regression test be added?
7. **Correctness & edge cases:** null/empty/error paths, async races, PWA/offline behavior.
8. **Scope:** Does the PR do only what its issue asked? Flag unrelated drive-by changes.
9. **Security/privacy:** No secrets committed, no obvious injection or unsafe data handling.

End every review with an explicit **recommendation**: `request changes`, `comment`, or
`looks good — maintainer decision`. Never imply approval of a deny-list change.

## Deny-list — areas that ALWAYS require the maintainer

Agents must **not** implement, and must **flag for maintainer review**, anything touching:

- **IndexedDB schema or migrations** (`web/src/lib/db.js` shape, stores, indexes, versioning).
- **FSRS grading logic** (`web/src/lib/scheduler.js` and how grades/due dates are derived).
- **DynamoDB / Amplify sync** (`web/src/lib/sync.js`, `web/src/lib/amplifyAdapter.js`, `web/src/lib/amplifyConfig.js`,
  `web/amplify/**`) — anything crossing the local ↔ cloud boundary.
- **Secrets / auth** (`web/src/Auth.jsx`, Cognito config, `amplify_outputs.*`, any credential).

When in doubt about whether something is deny-listed, treat it as deny-listed.
