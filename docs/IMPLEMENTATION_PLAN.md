# Implementation Plan — German Noun & Article Trainer

**Status:** Draft v1
**Date:** June 2026
**Companion to:** `DESIGN.md`

This plan is organized into phases that each end in something usable. The guiding principle: **you should be practicing German on your phone by the end of Phase 0**, before any AWS work exists. Each later phase adds durability and breadth without blocking daily use.

**Platform: decided — Progressive Web App (React).** Rationale and the reconsider-triggers are in `DESIGN.md §2.1`. The same codebase can later be Capacitor-wrapped into native iOS/Android shells with no rewrite if that ever becomes worthwhile, so this is a low-regret commitment.

---

## Phasing at a glance

| Phase | Outcome | Rough effort | AWS? |
|---|---|---|---|
| 0 | Usable offline PWA, A1 nouns, FSRS loop | ~1–3 days | No |
| 0.5 | Polish & calibration backlog (cram mode, override gesture, grading calibration, theme setting, a11y) | ~1–3 days | No |
| 1 | Auth + cross-device progress sync + review log | ~3–5 days | Yes |
| 2 | A2/B1 + frequency-banded upper levels; settings | ~2–4 days | Yes |
| 3 | New card types (verbs, etc.) on the shared engine | ongoing | Yes |

Effort estimates assume a technically comfortable solo developer working in focused sessions, not full-time days.

---

## Pre-work: the content pipeline

This produces the static `nouns.json` the app ships with. Do it once; keep it re-runnable.

**Tasks**
1. Download Goethe A1 (and later A2, B1) Wortliste PDFs. Extract noun entries → `{ lemma, level }`. Expect to clean PDF-extraction noise (hyphenation, plural notation, article markers).
2. `pip install german-nouns`; load the CSV / use the lookup module.
3. For each Goethe lemma, look up gender + plural in `german-nouns`. Map gender `m/f/n → der/die/das`.
4. Log mismatches to a `to_review.csv` and hand-fix (compounds, variants, proper-noun edge cases).
5. Attach English gloss + one example sentence per noun.
6. Emit `nouns.json` conforming to the content schema in `DESIGN.md §3.4`.
7. Write `SOURCES.md` recording dump versions + licenses (CC BY-SA for Wiktionary-derived data; Goethe copyright noted).

**Acceptance criteria**
- `nouns.json` validates against the schema.
- Every A1 noun has a non-empty `article` and `plural` (or an explicit "no plural" marker).
- Mismatch count is zero or fully accounted for in `to_review.csv`.

**Deliverable:** `pipeline/` (script + raw inputs + `nouns.json` + `SOURCES.md`).

---

## Phase 0 — Offline PWA MVP (no backend)

**Goal:** a working der/die/das trainer on your phone, progress stored locally, no login.

### Stack
- React (Vite or Next.js) configured as a **PWA** (web manifest + service worker; "Add to Home Screen" installable).
- **`ts-fsrs`** for scheduling.
- **IndexedDB** for local persistence (a thin wrapper like Dexie keeps it pleasant).
- `nouns.json` bundled as a static asset.

### Tasks
1. Scaffold the PWA; confirm it installs to a phone home screen and launches offline.
2. Load `nouns.json`; initialize an FSRS card-state record per noun in IndexedDB on first run (lazily, for the chosen level).
3. Build the **review loop** (single-interaction grading):
   - select due cards + a daily new-card budget;
   - show bare noun and **start a latency timer**;
   - user taps der/die/das — this single tap *is* the answer and the grade (no separate self-rating step);
   - record raw signals: `latency_ms`, `switches` (selection changes before commit), `first_attempt_correct`;
   - reveal correctness (+ plural, + example);
   - derive the FSRS rating from correctness + normalized signals (task 4), call `scheduler.next(card, now, rating)`;
   - persist updated state to IndexedDB; append a local log entry with **both the rating and the raw signals** (per `DESIGN.md §4.5`).
4. Implement **implicit grading** (`DESIGN.md §4.6`):
   - wrong tap → **Again**; correct → bucket into **Hard/Good/Easy** by normalized latency, with any hesitation/switch bumping the grade down a level;
   - **normalize latency** against a rolling baseline (per-user speed, word length, within-session position); **clip outliers** (backgrounded app / implausibly long) and discard them rather than scoring a lapse;
   - add a **manual-override gesture** (e.g. long-press after answering) to correct a wrong inference; record `overridden: true` in the log;
   - keep the threshold logic isolated and swappable so it can be retuned from logged data later.
5. Minimal UI polish: gender color-coding toggle, a "due today / new today" counter, an end-of-session summary.
6. Empty-state and "all caught up" handling.

### Acceptance criteria
- A full session runs **offline** start to finish.
- Reviewing requires **one tap per card** — no separate self-rating step.
- Latency and hesitation are captured and logged as raw signals alongside the derived rating; outliers are clipped, not scored.
- A faster correct answer yields a longer next interval than a slow/hesitant correct answer on the same card; a wrong tap shortens it.
- The manual-override gesture changes the applied grade and is recorded in the log.
- Failing a card makes it reappear within the same or next session; consistently passing pushes its interval out.
- Closing and reopening the app preserves all progress (IndexedDB survives).
- Installs and runs as a standalone app on your actual phone.

### Decision gate
Phase 0 is also the honest test of *DESIGN.md §12* — if the bespoke UX doesn't feel meaningfully better than an Anki deck, reconsider scope before building AWS.

---

## Phase 0.5 — Polish & calibration backlog (no backend)

**Goal:** close the gaps surfaced while finishing Phase 0 (dark-mode theming, empty-state messaging, real first-session use). None of these need AWS; they make the existing loop feel right and are good "while deciding on the gate" work. Roughly ordered by value.

### Opportunities

1. **Make the scheduler legible (highest value).** First-run reaction to the app was "I didn't realize there's a schedule" — when a noun feels shaky but FSRS has marked it done, the only recourse today is the override row, which isn't discoverable. Two parts:
   - **Cram / "drill anyway" mode.** A practice path decoupled from due dates, so the user can drill a chosen level or a shaky-words set without waiting for the schedule. Must *not* corrupt FSRS state — either log these as off-schedule practice or apply ratings through the normal path explicitly opted into. Directly answers the "I still need to work on these" instinct.
   - **Surface "why nothing's due."** The "all caught up / next review in ~X" empty state (done) is the first half; consider a small always-visible due-countdown so the schedule never feels like a black box.

2. **Finish the manual-override affordance.** `DESIGN.md §4.6` specifies a **long-press gesture** to correct a wrong inference; only the button row is implemented. This is an unmet Phase 0 acceptance criterion, not new scope — wire the gesture and keep `overridden: true` logging.

3. **Calibrate implicit-grading thresholds from real logs.** The `TUNING` constants in `inference.js` are still the guessed defaults, but `DESIGN.md §4.5–4.6` always intended them to be retuned from logged data — and real A1 sessions now exist. Analyze the local review log (latency distribution, hesitation, override rate) and recalibrate `EASY_RATIO` / `HARD_RATIO` / baseline window so Hard/Good/Easy reflect actual recall, not priors. Keep the logic swappable (it already is).

4. **Promote theme to a setting + set a browser baseline.** Dark mode is currently auto-only (`prefers-color-scheme`). Add a light / dark / auto toggle — it belongs in the Phase 2 settings screen, so either fold it in there or ship a minimal version now. Separately, the dark-mode bug (the app shipped `color-mix()`, unsupported on the target phone browser, causing a light-on-light contrast failure) is a lesson: **pick and document a baseline browser target** and avoid modern-only CSS without a fallback.

5. **Contrast / accessibility pass on both themes.** Sweep light and dark for legibility (the `color-mix` issue proves it's worth doing). Note that der = blue / die = red / das = green is a red-green pairing — acceptable behind the color-coding toggle, but a non-color cue (icon, position) is an option if it ever matters.

6. **Reminders follow-on.** The in-app "next due in ~X" text is the textual half of review reminders; the natural extension is **web push** so the user doesn't have to remember to reopen. This is already listed as *optional* in Phase 2 (task 6) — noted here because Phase 0.5 built the groundwork.

### Acceptance criteria
- A user who feels shaky on a "done" noun has an obvious, non-destructive way to drill it.
- The long-press override changes the applied grade and is logged (`overridden: true`).
- Grading thresholds are derived from the logged review history, with the before/after rationale recorded.
- Dark mode renders with sufficient contrast on the actual target phone browser, with no reliance on unsupported CSS.

---

## Phase 1 — Auth + sync (AWS)

**Goal:** progress and review history persist server-side and follow you across devices/reinstalls.

### Decision to make first
**Amplify Gen 2** (recommended fast path) vs. **Cognito + API Gateway + Lambda + DynamoDB** (more control). See `DESIGN.md §5.1`. Both land on the same DynamoDB model, so this is reversible.

### Tasks
1. Stand up **Cognito** auth; add sign-in to the PWA. Gate sync (not study) behind auth so offline practice still works logged-out.
2. Provision **DynamoDB** single table per `DESIGN.md §6` (card state, review log, settings).
3. Implement sync:
   - **push:** queued local state deltas + log entries → server;
   - **pull:** newer card states from other devices (last-write-wins on `last_review`);
   - run on app open and on regaining connectivity (background sync where supported).
4. Write the **append-only review log** server-side (distinct sort keys, never conflicts).
5. Conflict + offline-queue handling: local writes never block on network; the queue drains when online.
6. Basic observability: CloudWatch logs on the Lambda/data layer; a simple "last synced" indicator in the UI.

### Acceptance criteria
- Practice on device A, open device B → progress matches after sync.
- Airplane-mode session later syncs cleanly with no lost reviews.
- Review log in DynamoDB is complete and ordered.

---

## Phase 2 — Levels + settings

**Goal:** full A1–B1 plus proxied B2–C2, with user-facing controls.

### Tasks
1. Extend the pipeline to A2 and B1; regenerate `nouns.json`.
2. Add **frequency-banded B2–C2** (drop words already in A1–B1; assign bands from a free frequency source). Label these clearly as frequency-proxied, not official.
3. **Settings screen:** active levels, new-cards-per-day budget, `request_retention` target, gender color-coding toggle, plural-drilling toggle.
4. **Plural drilling** per the chosen design (second prompt on the card, or separate card type — decide per `DESIGN.md §11.3`).
5. Light **progress dashboard:** counts by level, retention estimate, streak. (Reads from the review log.)
6. *(Optional)* **Daily review reminders** via web push. Works on Android natively and on iOS for home-screen-installed PWAs (iOS 16.4+). Note the iOS caveats — install required, no background refresh, occasional delivery flakiness — and treat reminders as a nice-to-have, not core. Defer or drop if it adds disproportionate complexity.

### Acceptance criteria
- Switching active levels seeds/activates the right cards without disturbing existing progress.
- Changing `request_retention` visibly changes interval lengths.

---

## Phase 3 — New card types (ongoing)

**Goal:** prove the extensibility claim by adding a second content type on the unchanged engine.

### Approach
For each new type, you add only: (a) data, (b) a renderer, (c) a grader. Scheduling, sync, logging, and progress are reused as-is.

### Candidate first extension
**Verb conjugation** (present tense, high-frequency irregulars) — distinct enough from nouns to validate the generic `{ type, prompt, answer, metadata }` model, useful enough to keep you engaged.

### Acceptance criteria
- A verb card schedules, syncs, and logs through the exact same code paths as a noun card, with no changes to the scheduler.

---

## Optional later — native packaging (Capacitor)

Not a planned phase; an escape hatch documented so the path is known. If you ever want App-Store packaging, more reliable push notifications, or OS-deep features, wrap the existing web app with **Capacitor** to produce native iOS/Android binaries. This reuses the React UI, scheduler, sync, and content code — no rewrite. Triggers for doing this are listed in `DESIGN.md §2.1`. Until one of those triggers fires, the PWA is the product.

---

## Testing strategy
- **Scheduler:** unit-test the rating→`ts-fsrs` mapping and that Again shortens / Good lengthens intervals as expected. Treat `ts-fsrs` itself as trusted; test *your usage* of it.
- **Implicit grading:** unit-test the signals→rating logic with synthetic inputs — fast-correct → Easy, slow-correct → Hard, hesitation downgrades, wrong → Again. Test that latency normalization holds the rating stable across long vs. short words, and that clipped outliers produce no log entry rather than a lapse.
- **Pipeline:** schema validation + a fixture set of known nouns with asserted articles/plurals (e.g. `das Mädchen`, `die Zeitung`, `der Tisch`).
- **Sync:** simulate two clients + offline queue; assert no lost or duplicated log entries.
- **Manual:** real-device install + a multi-day usage run before declaring a phase done (interval behavior only shows over days).

---

## Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Goethe PDF extraction is messy | High | Budget hand-cleaning time; keep `to_review.csv`; the A1–B1 set is small enough to fully verify |
| `german-nouns` misses or mis-genders some lemmas | Medium | Mismatch report + manual override file checked into the repo |
| B2–C2 frequency proxy feels arbitrary | Medium | Label clearly; treat upper levels as optional; revisit if a better source appears |
| Over-engineering AWS before the loop is proven | Medium | Phase 0 ships with zero AWS; decision gate before Phase 1 |
| Scope creep into a full course | Medium | Non-goals in `DESIGN.md §1`; the generic card model absorbs new content without new infrastructure |
| Building this when Anki would do | Low–Med | Explicit decision gate at end of Phase 0 (`DESIGN.md §12`) |

---

## Suggested first three sessions
1. **Session 1:** run the content pipeline for A1 only; produce and eyeball `nouns.json`.
2. **Session 2:** scaffold the PWA, wire `ts-fsrs` + IndexedDB, get the bare review loop working in the browser.
3. **Session 3:** PWA-ify (manifest + service worker), install on your phone, do a real session. You now have a usable trainer — everything after is durability and breadth.
