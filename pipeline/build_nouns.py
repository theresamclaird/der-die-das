#!/usr/bin/env python3
"""
Content pipeline: German A1 noun-article trainer.

Joins a curated A1 lemma list (curator-supplied article + gloss) against the
`german-nouns` dataset (Wiktionary-derived) to attach gender + plural, validates
the result, and emits a flat `nouns.json` array of cards matching DESIGN.md §3.4.

Anything that can't be resolved cleanly is written to `to_review.csv` rather than
silently guessed — the join is meant to be auditable.

Usage:
    python build_nouns.py \
        --in data/a1_nouns.csv \
        --out out/nouns.json \
        --review out/to_review.csv \
        --level A1

Swap the input CSV for one derived from the official Goethe A1 Wortliste to
produce the real dataset; set --level-source goethe in that case.

To build the full A1-C2 dataset in one pass (the normal mode), run:

    python build_nouns.py --all

which iterates the LEVELS manifest below, dedupes lemmas across levels
(keeping the lowest CEFR level a noun appears in), and emits one merged
nouns.json.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path

from german_nouns.lookup import Nouns

GENDER_TO_ARTICLE = {"m": "der", "f": "die", "n": "das"}
ARTICLE_TO_GENDER = {v: k for k, v in GENDER_TO_ARTICLE.items()}

# --- English gloss: definite-article prefix ------------------------------------
# The UI renders each gloss as "the <translation>" so it mirrors the German
# article ("das Obst" -> "the fruit"). That reads naturally for ordinary count
# nouns but wrong for mass/abstract nouns ("the water", "the love") and proper
# nouns ("the Monday", "the German"). Whether a noun takes "the" is a property of
# the WORD, so it's curated here and emitted as the per-card `gloss_def` flag
# (default True; the lemmas below opt out). Keyed on the German lemma because it's
# unambiguous — English glosses collide (e.g. "knowledge" <- both Wissen and
# Kenntnis), so keying on the gloss would mislabel. Extend as content grows.
NO_DEFINITE_ARTICLE = frozenset({
    # Uncountable substances / foods (note: Obst -> "the fruit" stays definite by
    # request; countable-ish glosses like Eis -> "ice cream" also keep "the").
    "Wasser", "Brot", "Kaffee", "Tee", "Milch", "Fleisch", "Zucker", "Salz",
    "Butter", "Reis", "Mehl", "Gemüse",
    # Weather / elements
    "Regen", "Schnee", "Wetter", "Nebel", "Hitze", "Kälte",
    # Abstract states, emotions, qualities (non-count)
    "Geld", "Arbeit", "Musik", "Luft", "Zeit", "Hilfe", "Gesundheit", "Frieden",
    "Liebe", "Angst", "Wut", "Freude", "Hoffnung", "Stress", "Schlaf", "Geduld",
    "Mut", "Wissen", "Freiheit", "Gewalt", "Stolz", "Neid", "Natur",
    "Hunger", "Durst", "Glück", "Pech", "Ruhe", "Information", "Hass", "Spaß",
    "Glaube",
    # Mass collectives
    "Verkehr", "Gepäck", "Müll", "Bargeld", "Schmutz", "Staub", "Lärm",
    # Proper nouns: English drops the article where German keeps it. Mostly not in
    # the dataset yet — listed so they're handled when such content is added.
    "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag",
    "Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August",
    "September", "Oktober", "November", "Dezember",
    "Deutsch", "Englisch", "Französisch", "Spanisch", "Italienisch", "Russisch",
    "Deutschland", "Österreich", "Europa", "Frankreich", "England", "Italien",
})

# Full-dataset manifest (used by --all). Order matters: it is the CEFR
# progression A1 -> C2, and dedup keeps the FIRST (lowest) level a lemma
# appears in. A1-B1 are curated CEFR lists; B2-C2 are a frequency-band
# proxy (DESIGN §3.1) and are labelled as such in `level_source`.
LEVELS = [
    ("A1", "data/a1_nouns.csv", "curated_a1_starter"),
    ("A2", "data/a2_nouns.csv", "curated"),
    ("B1", "data/b1_nouns.csv", "curated"),
    ("B2", "data/b2_nouns.csv", "frequency"),
    ("C1", "data/c1_nouns.csv", "frequency"),
    ("C2", "data/c2_nouns.csv", "frequency"),
]

# Transliteration for building ASCII ids from German lemmas.
UMLAUT_MAP = str.maketrans(
    {"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss", "Ä": "Ae", "Ö": "Oe", "Ü": "Ue"}
)


def slug(lemma: str) -> str:
    return "noun_" + lemma.translate(UMLAUT_MAP).lower().replace(" ", "_").replace("-", "_")


def genders_of_entry(entry: dict) -> set[str]:
    """Collect genders from an entry, handling both 'genus' and 'genus 1/2/3'."""
    out: set[str] = set()
    for key, val in entry.items():
        if key == "genus" or key.startswith("genus "):
            if val in GENDER_TO_ARTICLE:
                out.add(val)
    return out


# Plural can appear under a single key, numbered variants (multiple valid plurals),
# or adjectival-declension keys. Priority order picks the standard primary form.
_PLURAL_KEYS = [
    "nominativ plural", "nominativ plural 1", "nominativ plural 2", "nominativ plural 3",
    "nominativ plural stark", "nominativ plural gemischt", "nominativ plural schwach",
]


def extract_plural(flexion: dict) -> str | None:
    for k in _PLURAL_KEYS:
        if flexion.get(k):
            return flexion[k]
    for k, v in flexion.items():  # fallback: any nominativ-plural-ish key
        if k.startswith("nominativ plural") and v:
            return v
    return None


def noun_entries(raw: list[dict]) -> list[dict]:
    """Keep only entries tagged as nouns (Substantiv)."""
    return [e for e in raw if "Substantiv" in (e.get("pos") or [])]


def lookup(nouns: Nouns, lemma: str) -> tuple[set[str], str | None, bool]:
    """
    Returns (candidate_genders, plural_or_None, found).
    Plural is taken from the first entry that carries one.
    """
    raw = nouns[lemma]
    if not raw:
        return set(), None, False
    entries = noun_entries(raw) or raw
    genders: set[str] = set()
    plural: str | None = None
    for e in entries:
        genders |= genders_of_entry(e)
        if plural is None:
            p = extract_plural(e.get("flexion") or {})
            if p:
                plural = p
    return genders, plural, True


@dataclass
class Card:
    id: str
    type: str
    lemma: str
    article: str
    plural: str | None
    gender: str
    level: str
    level_source: str
    topic: str
    translation: str
    gloss_def: bool  # does the English gloss take "the"? (mass/abstract/proper nouns don't)
    example: str | None


@dataclass
class ReviewItem:
    lemma: str
    reason: str
    detail: str = ""


def resolve(row: dict, nouns: Nouns, level: str, level_source: str,
            review: list[ReviewItem]) -> Card | None:
    lemma = (row.get("lemma") or "").strip()
    if not lemma:
        return None

    seed_article = (row.get("article") or "").strip().lower() or None
    if seed_article and seed_article not in ARTICLE_TO_GENDER:
        review.append(ReviewItem(lemma, "bad_seed_article", f"got {seed_article!r}"))
        seed_article = None
    seed_gender = ARTICLE_TO_GENDER.get(seed_article) if seed_article else None

    candidates, plural, found = lookup(nouns, lemma)

    # --- decide gender/article -------------------------------------------------
    if not found:
        if seed_gender:
            # Not in dataset, but curator gave an article: trust it, flag for review.
            review.append(ReviewItem(lemma, "not_in_dataset", "using curator article; verify plural"))
            gender, article = seed_gender, seed_article
        else:
            review.append(ReviewItem(lemma, "not_in_dataset", "no curator article either; skipped"))
            return None
    elif not candidates:
        # Found but no gender (e.g. plurale tantum like 'Eltern').
        if seed_gender:
            review.append(ReviewItem(lemma, "no_gender_in_dataset", "plural-only? using curator article"))
            gender, article = seed_gender, seed_article
        else:
            review.append(ReviewItem(lemma, "no_gender_in_dataset", "plural-only and no curator article; skipped"))
            return None
    elif len(candidates) == 1:
        gender = next(iter(candidates))
        article = GENDER_TO_ARTICLE[gender]
        if seed_gender and seed_gender != gender:
            # Curator and dataset disagree on a single-gender word -> trust curator, flag loudly.
            review.append(ReviewItem(lemma, "gender_conflict",
                                     f"curator={seed_article} dataset={article}; using curator"))
            gender, article = seed_gender, seed_article
    else:
        # Multiple candidate genders (e.g. der/die See, multi-genus Joghurt).
        if seed_gender and seed_gender in candidates:
            others = sorted(candidates - {seed_gender})
            review.append(ReviewItem(lemma, "ambiguous_resolved",
                                     f"dataset has {sorted(candidates)}; curator picked {seed_article}"))
            gender, article = seed_gender, seed_article
        elif seed_gender:
            review.append(ReviewItem(lemma, "ambiguous_conflict",
                                     f"dataset has {sorted(candidates)}, none match curator {seed_article}; using curator"))
            gender, article = seed_gender, seed_article
        else:
            review.append(ReviewItem(lemma, "ambiguous_unresolved",
                                     f"dataset has {sorted(candidates)}, no curator article; skipped"))
            return None

    if plural is None:
        review.append(ReviewItem(lemma, "no_plural", "mass/plural-less noun, or dataset gap"))

    return Card(
        id=slug(lemma),
        type="noun_article",
        lemma=lemma,
        article=article,
        plural=plural,
        gender=gender,
        level=level,
        level_source=level_source,
        topic=(row.get("topic") or "").strip(),
        translation=(row.get("translation") or "").strip(),
        gloss_def=lemma not in NO_DEFINITE_ARTICLE,
        example=(row.get("example") or "").strip() or None,
    )


def validate(cards: list[Card]) -> list[str]:
    errors: list[str] = []
    seen_ids: dict[str, str] = {}
    for c in cards:
        if c.article not in ARTICLE_TO_GENDER:
            errors.append(f"{c.lemma}: invalid article {c.article!r}")
        if GENDER_TO_ARTICLE.get(c.gender) != c.article:
            errors.append(f"{c.lemma}: gender {c.gender!r} inconsistent with article {c.article!r}")
        if not c.translation:
            errors.append(f"{c.lemma}: empty translation")
        if c.id in seen_ids:
            errors.append(f"duplicate id {c.id!r} from {c.lemma!r} and {seen_ids[c.id]!r}")
        seen_ids[c.id] = c.lemma
    return errors


def cards_from_file(in_path: Path, nouns: Nouns, level: str, level_source: str,
                    review: list[ReviewItem]) -> list[Card]:
    cards: list[Card] = []
    with in_path.open(encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            card = resolve(row, nouns, level, level_source, review)
            if card:
                cards.append(card)
    return cards


def build_all(nouns: Nouns, review: list[ReviewItem]) -> list[Card]:
    """Build every level in LEVELS, deduping lemmas across levels.

    A lemma that appears in more than one input is kept at the LOWEST level
    (LEVELS is ordered A1->C2); later, higher-level occurrences are dropped
    and logged so the duplication is auditable.
    """
    cards: list[Card] = []
    seen: dict[str, str] = {}  # lemma -> level it was first kept at
    for level, infile, level_source in LEVELS:
        in_path = Path(infile)
        if not in_path.exists():
            print(f"  WARN: {level} input not found: {in_path} (skipped)", file=sys.stderr)
            continue
        before = len(cards)
        for card in cards_from_file(in_path, nouns, level, level_source, review):
            if card.lemma in seen:
                review.append(ReviewItem(card.lemma, "duplicate_across_levels",
                                         f"already at {seen[card.lemma]}; dropped from {level}"))
                continue
            seen[card.lemma] = level
            cards.append(card)
        print(f"  {level}: +{len(cards) - before} cards", file=sys.stderr)
    return cards


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--all", action="store_true",
                    help="build every level in the LEVELS manifest, merged + deduped")
    ap.add_argument("--in", dest="infile", default="data/a1_nouns.csv")
    ap.add_argument("--out", dest="outfile", default="out/nouns.json")
    ap.add_argument("--review", dest="reviewfile", default="out/to_review.csv")
    ap.add_argument("--level", default="A1")
    ap.add_argument("--level-source", default="curated_a1_starter")
    args = ap.parse_args()

    print(f"Loading german-nouns dataset...", file=sys.stderr)
    nouns = Nouns()

    review: list[ReviewItem] = []
    if args.all:
        print("Building all levels (A1-C2)...", file=sys.stderr)
        cards = build_all(nouns, review)
    else:
        in_path = Path(args.infile)
        if not in_path.exists():
            print(f"ERROR: input not found: {in_path}", file=sys.stderr)
            return 2
        cards = cards_from_file(in_path, nouns, args.level, args.level_source, review)

    errors = validate(cards)
    if errors:
        print("\nVALIDATION ERRORS (output not written):", file=sys.stderr)
        for e in errors:
            print("  - " + e, file=sys.stderr)
        return 1

    out_path = Path(args.outfile)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as fh:
        json.dump([asdict(c) for c in cards], fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    review_path = Path(args.reviewfile)
    with review_path.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["lemma", "reason", "detail"])
        for r in review:
            w.writerow([r.lemma, r.reason, r.detail])

    # ---- summary --------------------------------------------------------------
    by_reason: dict[str, int] = {}
    for r in review:
        by_reason[r.reason] = by_reason.get(r.reason, 0) + 1
    no_plural = sum(1 for c in cards if c.plural is None)
    by_level: dict[str, int] = {}
    for c in cards:
        by_level[c.level] = by_level.get(c.level, 0) + 1

    print(f"\nWrote {len(cards)} cards -> {out_path}")
    print("  by level              : " + ", ".join(
        f"{lvl}={by_level[lvl]}" for lvl in sorted(by_level)))
    print(f"  with example sentence : {sum(1 for c in cards if c.example)}")
    print(f"  without plural        : {no_plural}")
    print(f"\nReview items: {len(review)} -> {review_path}")
    for reason, n in sorted(by_reason.items()):
        print(f"  {reason:24s} {n}")
    print(f"\nGenerated {datetime.now(timezone.utc).isoformat(timespec='seconds')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
