# Design Document — German Noun & Article Trainer

**Status:** Draft v1
**Date:** June 2026
**Author:** (you)
**Scope:** A mobile-first spaced-repetition web app for practicing German noun genders (der/die/das), starting with CEFR-leveled nouns and designed to extend to verbs, phrases, and grammar.

---

## 1. Goals & non-goals

### Goals
- Practice German nouns and their definite articles on a phone, in short sessions, whenever there's a spare moment.
- Filter and progress through content by CEFR level (A1 → C2).
- Use a modern spaced-repetition scheduler so struggling words resurface more often and mastered words fade into long intervals — automatically, with no manual tuning.
- Persist progress in AWS so it survives across devices and reinstalls.
- Be architected so verbs, phrases, and grammar can be added later as new *card types* without rebuilding the core.

### Non-goals (for now)
- Not a course or curriculum; it assumes the user is re-activating prior knowledge, not learning from zero.
- No social features, sharing, or multi-user collaboration.
- No audio recording / speech recognition in v1 (pronunciation is out of scope initially).
- Not aiming for app-store native apps; a Progressive Web App (PWA) covers the mobile need.

### Primary user
A single returning learner (intermittent usage, mobile-first, technically capable). The design should comfortably support a small number of users later, but should not pay the complexity tax of large-scale multi-tenancy now.

---

## 2. Core design decisions (summary)

| Concern | Decision | Rationale |
|---|---|---|
| Platform | Progressive Web App (React); Capacitor-wrappable later | Web stack is familiar; personal use removes native's main advantages; no rewrite needed to go native if that changes |
| Content leveling | Goethe-Institut Wortlisten (A1–B1) + frequency banding for B2–C2 | Canonical CEFR source; frequency is a reasonable proxy where official lists thin out |
| Gender/grammar data | `gambolputty/german-nouns` (Wiktionary-derived CSV) | ~100k nouns with gender + plural + declension, free |
| Content delivery | Pre-joined static file (JSON/SQLite) shipped with the app | Vocabulary is static; no DB needed for it |
| Scheduler | FSRS via `ts-fsrs` | Modern, fewer reviews for same retention, recovers well after breaks, drop-in TypeScript library |
| Grading | Committed der/die/das tap = grade; Hard/Good/Easy inferred from latency + hesitation | No per-card self-rating (removes tedium); raw signals logged for later recalibration |
| Frontend | React PWA, offline-capable | Feels native on phone, installable, works without signal |
| Backend | Serverless AWS (Amplify Gen 2 *or* Cognito + API Gateway + Lambda + DynamoDB) | Scales to near-zero cost for one user |
| Progress store | DynamoDB (per-user FSRS state + append-only review log) | Tiny items, instant lookups, cheap |

### 2.1 Platform choice: PWA (not native, not React Native)

This is a single-user, mobile-first, web-developer-built tool. That trio decides it.

- **Why PWA.** The app is mechanically just text rendering, tap capture, small local storage, and a scheduler — squarely within what the web does well. It needs no native-only hardware APIs (camera, GPS, Bluetooth, sensors). Offline sessions, home-screen install, and reminder notifications all work in a PWA today.
- **Why not native (Swift/Kotlin).** Native's headline advantages — App Store distribution, discovery, ratings, store-driven installs — are irrelevant to personal use. The remaining advantages (deep OS integration, widgets, most-reliable push) aren't required by this app. The cost (a new language/toolchain) directly delays a usable tool.
- **Why not React Native/Expo.** A reasonable option that reuses React skills, but it pulls in the native build/sign/provision toolchain (simulators or EAS builds, signing, TestFlight/sideload) for benefits this app mostly doesn't need. Better suited if shipping to both app stores becomes a goal, or if learning RN is itself the point.
- **Low-regret property.** Choosing PWA now does **not** foreclose native later: the same web codebase can be wrapped with **Capacitor** to produce native iOS/Android shells (for App Store packaging or more reliable push) without a rewrite. Starting web preserves optionality; starting native discards web's speed advantage up front.

**Reconsider native (or Capacitor-wrap) when:** reminder notifications become habit-critical and PWA push reliability frustrates; the tool is to be shared/published; OS-deep features (widget, Apple Watch quick-review, Siri) are wanted; or learning RN/Swift becomes a goal in itself.

---

## 3. Content layer

### 3.1 Sources

**Leveling — Goethe-Institut Wortlisten.** The canonical CEFR vocabulary lists. A1, A2, and B1 are published as free official PDFs and already include nouns with article and plural. These define the A1–B1 buckets.

**Upper levels (B2–C2).** Goethe does not maintain a single canonical wordlist for these the way it does for A1–B1 (the exams shift toward comprehension over a fixed lexicon). For these levels, bucket nouns by **frequency band** as a difficulty proxy, drawing from a free frequency source (e.g. Leipzig Corpora Collection, dwds, or the `wordfreq` package). This is explicitly a heuristic, not an official mapping, and should be labeled as such in the UI.

**Gender, plural, declension — `gambolputty/german-nouns`.** ~100,000 nouns parsed from German Wiktionary, available as CSV and on PyPI, with grammatical gender, plural forms, and declension. This is the article authority.

### 3.2 The join

The content build is a one-time (re-runnable) offline pipeline:

1. Parse the Goethe A1/A2/B1 noun entries → `{ lemma, level }`.
2. For B2–C2, take a frequency list, drop words already in A1–B1, and assign bands.
3. Look up each lemma in `german-nouns` → attach `gender (m/f/n → der/die/das)`, `plural`, optional `declension`.
4. Resolve mismatches (compound words, spelling variants) by hand — expect a few dozen across A1–B1.
5. Attach an English gloss and one example sentence per noun (from the Goethe list where present, otherwise authored or sourced).
6. Emit a single static artifact: `nouns.json` (or a bundled SQLite file).

Total A1–B1 volume is roughly 2,000–2,500 nouns — small enough to inspect and correct manually.

**Reality check from building the pipeline (A1).** The `german-nouns` data is noisier than this list implies, in two ways that shaped the design:
- *Multiple genders and plural forms are common.* The dataset frequently lists rare secondary genders (e.g. `Haus` as m/n, `Kaffee` as m/n) and numbered plural keys (`nominativ plural 1/2/3`). This is exactly why the curator-supplied article in the input list is **not redundant** with the dataset — it is the disambiguator that resolves which gender is the standard one. Every such resolution is logged for audit rather than silently chosen. The pipeline also selects the primary plural from the numbered variants.
- *Plurale tantum are excluded.* Plural-only nouns (e.g. *Eltern*, *Leute*) have no singular der/die/das gender, so they don't fit a gender-drilling card and would force a false `gender` value. They are intentionally dropped from the noun-article dataset; if wanted later, model them as a distinct card type. Mass nouns (e.g. *Fleisch*, *Obst*) are kept with `plural: null`.

### 3.3 Licensing notes (not legal advice)
- `german-nouns` derives from Wiktionary → **CC BY-SA**: attribution and share-alike apply if redistributed.
- Goethe Wortlisten are **Goethe-Institut copyright** — fine for a personal learning tool; revisit before any commercial release.
- Keep a `SOURCES.md` recording exactly which versions/dumps were used, for attribution and reproducibility.

### 3.4 Content schema

```jsonc
{
  "id": "noun_haus",
  "type": "noun_article",      // generic 'type' enables future card types
  "lemma": "Haus",
  "article": "das",            // der | die | das
  "plural": "Häuser",
  "gender": "n",               // m | f | n
  "level": "A1",               // A1..C2  (or FREQ_BAND_x for proxied levels)
  "level_source": "goethe",    // goethe | frequency
  "topic": "home",
  "translation": "house",
  "example": "Das Haus ist groß."
}
```

---

## 4. Memory & scheduling design

### 4.1 Why FSRS
The requirement "words I struggle with appear more often until I demonstrate proficiency" *is* spaced repetition — it does not require a custom frequency algorithm layered on top. The chosen engine is **FSRS (Free Spaced Repetition Scheduler)**, now the default scheduler in Anki, replacing the older SM-2. Compared to SM-2 it needs fewer reviews for the same retention and reschedules gracefully after gaps. It models memory with three quantities:

- **Retrievability (R):** probability of recall right now.
- **Stability (S):** days for R to drop from 100% to 90%.
- **Difficulty (D):** how hard the item is for this learner.

A failed card gets low stability → short next interval → it returns soon and keeps returning until stable. That is the "struggling words more often" behavior, for free.

### 4.2 Library
Use **`ts-fsrs`** (TypeScript, FSRS-6). It exposes a scheduler created via `fsrs(params)`; `scheduler.repeat(card, now)` previews all four outcomes, and `scheduler.next(card, now, rating)` returns the updated card state plus a review log entry. Ratings are **Again / Hard / Good / Easy**.

Configurable params worth exposing in settings later: `request_retention` (default 0.9), `maximum_interval`, `enable_fuzz`, and learning steps.

### 4.3 Per-card memory state (FSRS card shape)
`due`, `stability`, `difficulty`, `elapsed_days`, `scheduled_days`, `reps`, `lapses`, `state`, `last_review`. This blob is stored per user per card.

### 4.4 German-specific design choices
- **Test production, not recognition.** Present the bare noun and require the learner to produce *der/die/das* (and optionally the plural) before revealing. Recall is the target skill; recognition is too easy.
- **Committed three-button answer = the grade.** The learner taps der/die/das; that tap *is* the rating, with no separate self-assessment step. A wrong tap is a lapse; a correct tap is graded Hard/Good/Easy by implicit signals (§4.6). This removes per-card self-rating, which is the main source of review tedium.
- **Gender color-coding** (der = blue, die = red, das = green is the common convention) as an optional visual aid. Evidence is mixed but it's low-cost and many learners value it; make it a toggle.
- **Plural as an optional second prompt** on the same card, gated behind a setting, since plural recall is a distinct (harder) skill.

### 4.5 Review-history log
Every answer is written to an **append-only log** capturing both the derived rating and the raw signals behind it:

```jsonc
{
  "cardId": "noun_haus",
  "timestamp": "2026-06-20T14:03:22Z",
  "correct": true,
  "rating": "Good",          // the FSRS rating actually applied
  "latency_ms": 1840,        // card-shown → answer-committed
  "switches": 0,             // selection changes before commit (hesitation)
  "first_attempt_correct": true,
  "overridden": false,       // true if the user manually corrected the inferred grade
  "session_id": "..."        // for within-session normalization
}
```

Logging the **raw signals**, not just the final rating, is deliberate: it lets you (a) retrain FSRS parameters on your own history later, and (b) recalibrate the latency/hesitation → rating thresholds empirically instead of guessing them up front.

### 4.6 Implicit difficulty signals (no per-card self-rating)

The grade is inferred rather than asked, to keep reviews low-friction. Signals, in order of value:

1. **Correctness (objective).** Wrong committed tap → **Again**. This is the primary signal and needs no inference.
2. **Response latency.** Among correct answers, faster recall = stronger memory. Fast → **Easy**, normal → **Good**, slow → **Hard**.
3. **Hesitation.** Selection changes before commit (e.g. tapped *das*, switched to *die*) bump the grade down a level even when the final answer is correct.
4. **First-attempt correctness** (if retry-within-card is enabled): getting it only on the second tap is treated as a weak pass, not a clean one.

**Mandatory normalization.** Raw latency is meaningless in absolute terms and must be normalized against a rolling baseline that accounts for: the user's personal speed, word length (reading time scales with length before recall even begins), and position-in-session (fatigue slows later cards). Outliers must be **clipped, not scored** — if the app was backgrounded or a response took implausibly long, discard it as distraction rather than recording a lapse.

**Manual override affordance.** A single gesture (e.g. long-press after answering) lets the learner correct a wrong inference — marking a lucky guess as a lapse, or vice versa. Rare in practice, but it keeps the learner in control and flags mis-inferences in the log (`overridden: true`) for later threshold tuning.

**Noise tolerance.** Per card the inferred grade is noisy; across many reviews it averages out, and FSRS is robust to moderate rating noise. The raw-signal log is the safety net: thresholds can be retuned without having lost any information.

### 4.7 Future production signals
For later card types involving typed or spoken answers (plurals, verb forms, pronunciation), additional implicit signals become available: **keystroke corrections/backspaces** for typed input, and **speech recognition** (microphone) for spoken production. These are out of scope for v1 noun-article drilling and belong to future card types, not the initial difficulty-inference scheme.

---

## 5. System architecture

```
┌─────────────────────────────────────────────┐
│  PWA (React)  — installed to phone home screen │
│  ┌─────────────┐   ┌──────────────────────┐   │
│  │ Content file │   │ ts-fsrs scheduler    │   │
│  │ nouns.json   │   │ (runs client-side)   │   │
│  └─────────────┘   └──────────────────────┘   │
│  ┌──────────────────────────────────────────┐ │
│  │ IndexedDB — local card state + queued log │ │  ← works offline
│  └──────────────────────────────────────────┘ │
└───────────────┬─────────────────────────────┘
                │ sync (when online, authenticated)
                ▼
┌─────────────────────────────────────────────┐
│  AWS                                          │
│  Cognito (auth)                               │
│  API Gateway + Lambda  (or Amplify data layer)│
│  DynamoDB:                                     │
│    • per-user card state                      │
│    • append-only review log                   │
└─────────────────────────────────────────────┘
```

**Design principle: local-first.** The scheduler and content run entirely on the client, so a full review session works offline. AWS is a sync/durability layer, not on the critical path of a review. This directly serves the "practice whenever I have a moment" goal, including on the subway.

### 5.1 Backend options
- **Fast path — AWS Amplify Gen 2:** TypeScript-defined backend that provisions Cognito + a data layer over DynamoDB + hosting with minimal glue. Recommended starting point for a solo build.
- **À-la-carte — Cognito + API Gateway + Lambda + DynamoDB:** more boilerplate, more control. Choose if you want explicit ownership of the API surface.

Both converge on the same DynamoDB data model, so the choice is reversible.

### 5.2 Notifications & the native escape hatch
- **Review reminders (optional feature).** A daily "cards are due" reminder can use **web push**, which works on iOS for home-screen-installed PWAs (iOS 16.4+) and natively on Android. Caveats for iOS PWA push: the app must be added to the Home Screen first, there's no background content refresh, and delivery can occasionally be flaky. For *personal* reminders this is acceptable; treat it as a nice-to-have, not a core dependency.
- **Capacitor escape hatch.** If push reliability, app-store packaging, or OS-deep features ever become important, the existing web app can be wrapped with **Capacitor** to produce native iOS/Android binaries with native push — reusing the same React/scheduler/sync code rather than rewriting. This keeps the platform decision reversible at low cost.

---

## 6. Data model (DynamoDB)

Single-table design, partition by user.

| Entity | PK | SK | Attributes |
|---|---|---|---|
| Card state | `USER#<uid>` | `CARD#<cardId>` | FSRS state blob, `due` (ISO) |
| Review log | `USER#<uid>` | `LOG#<ts>#<cardId>` | `rating`, `elapsed_ms` |
| User settings | `USER#<uid>` | `SETTINGS` | retention target, toggles, active levels |

**Querying due cards:** add a GSI keyed on `USER#<uid>` with `due` as the sort key, so "cards due now" is a single `due <= now` range query. (For a fully local-first client, due selection can also happen entirely in IndexedDB, with DynamoDB used only for cross-device sync — see open questions.)

**Sync strategy:** last-write-wins per card keyed on `last_review` timestamp is sufficient for a single user on multiple devices. The append-only log never conflicts (distinct sort keys), so it can be pushed opportunistically.

---

## 7. Key flows

**Onboarding:** sign in (Cognito) → pick active level(s) → app seeds local card state for those nouns → first session begins. Works without a tutorial.

**Review session:** client selects due cards (+ a budget of new cards) → presents bare noun → learner produces article → reveal → rate Again/Hard/Good/Easy → `ts-fsrs` updates state → write to IndexedDB + queue log → next card. Entirely offline-capable.

**Sync:** on app open / network availability, push queued state + log deltas, pull any newer state from other devices.

**New-card introduction:** a daily budget (e.g. N new nouns/day, configurable) prevents review pile-ups, mirroring established SRS practice.

---

## 8. Extensibility

The single most important architectural rule: **keep the scheduler decoupled from content type.** Every studyable item is modeled generically as `{ id, type, prompt, answer, metadata }` with its own independent FSRS state. Consequences:

- A noun-article card, a verb-conjugation card, and a case-ending card are just different `type` values sharing one engine.
- New content types ship as new data + a small renderer/grader per type; the scheduling, sync, logging, and progress code are untouched.
- Per-item FSRS state means a learner can know a noun's gender cold while still drilling its plural — each is its own card.

Future types to anticipate: verb conjugation, separable-verb prefixes, prepositions + case, adjective endings, fixed phrases/Redewendungen.

---

## 9. Privacy & security
- Auth via Cognito; no passwords handled by app code.
- Stored data is non-sensitive (study progress), but still scoped per user via the partition key; no cross-user reads.
- No third-party analytics required; if added later, keep review data first-party.
- Content sources attributed in `SOURCES.md`.

---

## 10. Cost
At single-user / small-group scale, DynamoDB, Lambda, API Gateway, and Cognito all sit at or near free-tier. The content layer incurs no per-request cost (bundled static file). Hosting a PWA is cents/month (e.g. Amplify Hosting or S3 + CloudFront).

---

## 11. Open questions / decisions to make
1. **Rating UX:** ✅ **Decided** — committed der/die/das tap *is* the grade; Hard/Good/Easy inferred from normalized latency + hesitation, with a manual-override gesture. No per-card self-rating. See §4.6.
2. **Due-card selection home:** purely client-side (IndexedDB) with DynamoDB as dumb sync, vs. server-side due queries via GSI. Local-first is simpler and offline-friendly; revisit if multi-device divergence becomes painful.
3. **Plural drilling:** same card with a second prompt, or a separate card type from the start?
4. **B2–C2 leveling:** frequency-band proxy now, or defer upper levels until a better-leveled source is found?
5. **Amplify Gen 2 vs hand-rolled** backend — decide before Phase 1.
6. **Example sentences** for nouns lacking them in the Goethe lists: author, source, or generate?

---

## 12. Appendix — why not just use Anki?
Anki already does FSRS and could hold a German deck. This project is justified only if the bespoke UX matters: production-focused der/die/das drilling, gender color-coding, level filtering, plural gating, and a foundation for German-specific card types (case endings, separable verbs) that generic flashcards model awkwardly. If those don't end up mattering, a well-built Anki deck is the cheaper answer — worth honestly revisiting after Phase 0.
