# Content pipeline — German A1 noun-article trainer

Produces `nouns.json` (the static content layer described in `DESIGN.md §3`) by
joining a curated A1 lemma list against the Wiktionary-derived `german-nouns`
dataset to attach gender and plural, with an auditable review trail.

## Layout
```
pipeline/
  build_nouns.py        # the pipeline
  data/
    a1_nouns.csv        # input: curator-supplied lemma, article, topic, gloss, example
  out/
    nouns.json          # output: array of cards (DESIGN.md §3.4 schema)
    to_review.csv       # output: anything not resolved cleanly, for human review
  SOURCES.md            # provenance + licensing
  README.md
```

## Run
```bash
pip install german-nouns
cd pipeline
python build_nouns.py            # uses data/a1_nouns.csv -> out/nouns.json
```
Options: `--in`, `--out`, `--review`, `--level`, `--level-source`.

## Input format (`data/a1_nouns.csv`)
`lemma,article,topic,translation,example`
- **lemma** — capitalized German noun (required)
- **article** — der/die/das the curator intends (recommended; used to validate
  against and disambiguate the dataset)
- **topic** — for filtering in the app
- **translation** — English gloss (required; shown on the card)
- **example** — optional sentence; blank is fine

## How resolution works
For each lemma the pipeline looks it up in `german-nouns` and:
- **single gender, matches curator** → use it;
- **multiple candidate genders** (noisy Wiktionary data) → use the curator's
  article, log `ambiguous_resolved`;
- **dataset disagrees with curator** → trust the curator, log a conflict;
- **not in dataset** → fall back to the curator's article, log it;
- **no plural** (mass nouns) → emit `plural: null`, log `no_plural`.

Nothing is silently guessed — every non-trivial case lands in `to_review.csv`.
Validation (article validity, gender↔article consistency, non-empty gloss,
unique ids) must pass or no output is written.

## Producing the real A1 dataset
1. Get the official **Goethe-Institut A1 Wortliste** PDF.
2. Extract its nouns into the CSV format above (one row per noun, with article).
3. Run with `--level-source goethe`.
4. Work through `to_review.csv` and correct the input where needed.

The same flow produces A2/B1 by swapping the input list and `--level`.
