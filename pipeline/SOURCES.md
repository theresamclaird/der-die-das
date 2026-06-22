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

## CEFR leveling (A1)
- **Current input:** `data/a1_nouns.csv` is a **curated A1 starter set** (~124
  common beginner nouns) assembled for development, *not* the official list.
  `level_source` is therefore `curated_a1_starter`.
- **To use the official list:** replace `data/a1_nouns.csv` with one derived from
  the **Goethe-Institut A1 Wortliste** (free official PDF) and run with
  `--level-source goethe`. The Goethe lists are **Goethe-Institut copyright** —
  fine for personal use; revisit before any public/commercial release.

## Scope notes
- **Plurale tantum** (plural-only nouns such as *Eltern*, *Leute*) are
  intentionally excluded: they have no singular der/die/das gender and don't fit
  a gender-drilling card. If desired later, model them as a separate card type.
- **Mass nouns** (e.g. *Fleisch*, *Obst*, *Schnee*) are kept with `plural: null`.
