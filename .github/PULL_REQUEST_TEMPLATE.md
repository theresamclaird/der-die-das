<!--
Thanks for the PR! Keep it focused on a single issue.
See CONTRIBUTING.md and AGENTS.md before submitting.
-->

## Summary

<!-- What does this change do, and why? -->

Closes #<!-- issue number -->

## Affected area / surface

<!-- Pick all that apply -->

- [ ] scheduler (FSRS — ts-fsrs)
- [ ] inference (implicit/latency grading)
- [ ] db (IndexedDB: schema / state / review log)
- [ ] session (in-session re-show vs. graduate)
- [ ] sync (Amplify / DynamoDB / Cognito)
- [ ] UI (React components / styles)
- [ ] pipeline (Python content generation)
- [ ] content (nouns.json data)
- [ ] docs
- [ ] build / tooling / CI

## How was this tested?

<!-- Commands run, manual steps, screenshots for UI changes. -->

- [ ] `cd web && npm test` passes
- [ ] `npm run build` succeeds (if the app changed)

## Checklist

- [ ] Linked to an issue and scoped to only what it asks (no unrelated drive-bys)
- [ ] Matches the surrounding code style (no new formatter/linter smuggled in)
- [ ] Tests added or updated for any logic change
- [ ] No secrets committed (`amplify_outputs.*`, `.amplify`, credentials)

## Maintainer-only areas (deny-list)

Check any this PR touches — these **require maintainer review** (see `AGENTS.md`):

- [ ] IndexedDB schema or migrations (`web/src/lib/db.js`)
- [ ] FSRS grading logic (`web/src/lib/scheduler.js`)
- [ ] DynamoDB / Amplify sync or the local ↔ cloud boundary (`web/amplify/**`, `sync.js`, `amplify*.js`)
- [ ] Secrets / auth (`Auth.jsx`, Cognito config, credentials)
- [x] None of the above
