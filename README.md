# der · die · das

A German noun-article trainer: practice der/die/das with implicit, latency-based
grading and FSRS spaced repetition. Personal project.

## Repository

- **`docs/`** — design (`DESIGN.md`) and implementation plan (`IMPLEMENTATION_PLAN.md`).
- **`pipeline/`** — Python content pipeline producing the leveled noun dataset.
- **`web/`** — the Vite + React Progressive Web App (Phase 0).

## Quick start

```bash
cd web
npm install
npm run dev      # http://localhost:5173
npm test         # inference unit tests
npm run build    # production PWA build
```

To regenerate the word data:

```bash
cd pipeline
pip install german-nouns
python build_nouns.py            # writes out/nouns.json
cp out/nouns.json ../web/src/data/nouns.json
```

See `CLAUDE.md` for architecture invariants and conventions.
