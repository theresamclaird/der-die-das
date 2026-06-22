# Sources & Licensing

## Gender / plural / declension
- **Package:** [`german-nouns`](https://pypi.org/project/german-nouns/) (gambolputty)
- **Derived from:** German Wiktionary
- **License:** Wiktionary content is **CC BY-SA**. Redistribution of data derived
  from it carries attribution + share-alike obligations. Record the package
  version you build with.
- **Caveats observed:** the dataset frequently lists rare secondary genders
  (e.g. `Haus` as m/n, `Kaffee` as m/n) and multiple plural forms keyed
  `nominativ plural 1/2/3`. The pipeline resolves gender via the curator-supplied
  article and selects the primary plural; every such resolution is logged to
  `to_review.csv`.

## CEFR leveling (A1–C2)
- **Inputs:** one CSV per level under `data/` — `a1_nouns.csv` … `c2_nouns.csv`.
  Build the whole set with `python build_nouns.py --all`, which dedupes lemmas
  across levels (keeping the lowest level a noun appears in). The level→file→source
  manifest lives in `LEVELS` at the top of `build_nouns.py`.
- **A1–B1** are **curated CEFR lists** (`level_source` `curated_a1_starter` /
  `curated`), assembled for development — *not* the official Goethe lists.
- **B2–C2** are a **frequency-band proxy** (`level_source` `frequency`), per
  DESIGN §3.1: Goethe maintains no single canonical wordlist at these levels, so
  difficulty is approximated by lexical frequency/register. This is a heuristic,
  not an official CEFR mapping, and should be labelled as such in the UI.
- **To use the official lists:** replace the A1–B1 CSVs with ones derived from the
  **Goethe-Institut Wortlisten** (free official PDFs) and set `level_source` to
  `goethe` in the `LEVELS` manifest. The Goethe lists are **Goethe-Institut
  copyright** — fine for personal use; revisit before any public/commercial release.

## Scope notes
- **Plurale tantum** (plural-only nouns such as *Eltern*, *Leute*) are
  intentionally excluded: they have no singular der/die/das gender and don't fit
  a gender-drilling card. If desired later, model them as a separate card type.
- **Mass nouns** (e.g. *Fleisch*, *Obst*, *Schnee*) are kept with `plural: null`.
