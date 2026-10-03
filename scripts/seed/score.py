"""
Puntúa cuán otoñal es cada título del universo y elige el corpus.

    python score.py

1. deepseek-flash puntúa de 0 a 100 **todo** el universo, por lotes y a
   temperatura 0.1, en `PASSES` pasadas. Cada pasada baraja los títulos con otra
   semilla, así que cada uno cae en lotes de composición distinta, y la
   puntuación final es la media: con una sola pasada, la franja media tenía
   ruido de ±10 a ±40 según el lote, justo donde está el corte.
2. Las puntuaciones se guardan en `data/scores.jsonl` con la versión del prompt y
   la pasada: reejecutar no repite llamadas y da el mismo corpus, y cambiar el
   prompt invalida la caché por sí solo.
3. Entran al corpus los `CORPUS_SIZE[tipo]` de mejor media, con
   `autumn_score = media / 100`.

Hasta la versión anterior, una heurística de géneros y keywords decidía qué
títulos llegaban al modelo. Premiaba el terror y dejaba fuera clásicos otoñales
sin keywords estacionales, como *Tienes un e-mail*: ahora se puntúa todo.

Necesita `data/universe.jsonl` (fetch-tmdb.py). Produce `data/corpus.jsonl`.
"""

from __future__ import annotations

import hashlib
import json
import random
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from statistics import mean
from typing import Any

from openai import OpenAI, OpenAIError

from common import (
    CONTENT_TYPES,
    CORPUS_PATH,
    DATA_DIR,
    UNIVERSE_PATH,
    append_jsonl,
    content_key,
    read_jsonl,
    require_env,
    write_jsonl,
)

# Reparto 90/10: TMDB tiene muchas menos series con votos suficientes.
CORPUS_SIZE = {"movie": 4_500, "tv": 500}

MODEL = "deepseek-flash"
TEMPERATURE = 0.1  # clasificación: lo más estable posible
PASSES = 3
BATCH_SIZE = 25
WORKERS = 8
MAX_ATTEMPTS = 3
SCORES_PATH = DATA_DIR / "scores.jsonl"

# ─── Puntuación con el modelo ────────────────────────────────────────────────

SYSTEM_PROMPT = """\
You score how much films and TV series belong to autumn, for a recommendation app that only suggests what to watch in autumn.

For each title, give an integer from 0 to 100: how clearly it is an autumn watch, something people reach for once September comes and the leaves start falling. Judge the work itself: when and where it is set, its atmosphere, its themes and the mood it leaves. Genre alone decides nothing.

- 90–100: an autumn classic, a must-watch of the season. Autumn is part of its identity: it is set in the fall (a new school year at a college or boarding school, New England in October, Thanksgiving, the harvest), or the whole work breathes falling leaves, rain, wool sweaters, warm drinks, books and early nights. E.g. Dead Poets Society, Gilmore Girls, the Harry Potter films, When Harry Met Sally..., You've Got Mail, Over the Garden Wall.
- 70–89: strongly autumnal setting or mood without being a seasonal classic: cozy or classic mysteries, campus and academic life, small towns, rainy cities, family gatherings, nostalgia, melancholy, grief or coming of age with an autumn texture. E.g. Knives Out, Good Will Hunting, Little Women, The Holdovers, Fantastic Mr. Fox.
- 40–69: fits an autumn evening reasonably well but has no seasonal identity: reflective dramas, romances, fantasies or thrillers with some autumn texture.
- 10–39: seasonally neutral or at odds with autumn: mainstream action, bright comedies, most science fiction, stories centred on Christmas, winter, spring or summer holidays.
- 0–9: the opposite of autumn: summer, beaches and tropics, superhero blockbusters, space opera. E.g. Mamma Mia!, Guardians of the Galaxy.

Horror and the supernatural are not autumnal by themselves: being spooky is not being autumnal.
- Halloween and the Day of the Dead do count as autumn, but only when the story itself is about them or happens on them: trick-or-treating, costumes, jack-o'-lanterns, a Halloween night, the ofrenda. Those titles, horror or not, score 85–100. E.g. Hocus Pocus, Halloween (1978), Trick 'r Treat, Coco, It's the Great Pumpkin, Charlie Brown.
- Horror, ghosts, witches, vampires or monsters with an autumn setting but no Halloween (a harvest, an October night, falling leaves in the story) score by that setting, like any other title. E.g. Sleepy Hollow.
- Horror with neither Halloween nor an autumn setting scores 40 at most: haunted houses, possessions, gothic tales, folk horror, slashers. E.g. The Conjuring, Nosferatu.

Score each title on its own merits; do not rank the titles in the list against each other.
Reply with json only, in exactly this shape: {"scores": [{"id": 1, "score": 73}, ...]}, one entry per title, using the ids given."""

# Subir si cambia `describe`: forma parte de lo que ve el modelo.
FORMAT_VERSION = 1
PROMPT_VERSION = hashlib.sha256(f"{MODEL}|{FORMAT_VERSION}|{SYSTEM_PROMPT}".encode()).hexdigest()[:12]


class ScoringError(Exception):
    pass


def describe(index: int, row: dict[str, Any]) -> str:
    kind = "film" if row["type"] == "movie" else "TV series"
    year = f" ({row['year']})" if row["year"] else ""
    synopsis = (row["synopsis_en"] or row["synopsis"] or "")[:500]
    return (
        f"[{index}] {row['title_en']}{year} · {kind}\n"
        f"Genres: {', '.join(row['genres_en']) or '—'}\n"
        f"Keywords: {', '.join(row['keywords'][:20]) or '—'}\n"
        f"Synopsis: {synopsis}"
    )


def parse_scores(content: str, expected: int) -> list[int]:
    try:
        entries = json.loads(content)["scores"]
        by_id = {int(entry["id"]): entry["score"] for entry in entries}
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
        raise ScoringError(f"respuesta ilegible: {error}") from error
    if set(by_id) != set(range(1, expected + 1)):
        raise ScoringError(f"ids {sorted(by_id)} en vez de 1..{expected}")
    scores = [by_id[i] for i in range(1, expected + 1)]
    if not all(isinstance(s, int) and not isinstance(s, bool) and 0 <= s <= 100 for s in scores):
        raise ScoringError(f"puntuaciones fuera de 0–100: {scores}")
    return scores


def score_batch(client: OpenAI, batch: list[dict[str, Any]]) -> dict[str, int]:
    """Sin streaming: es un proceso por lotes y nadie lee la respuesta mientras llega."""
    listing = "\n\n".join(describe(i, row) for i, row in enumerate(batch, start=1))
    last_error: ScoringError | None = None
    for _ in range(MAX_ATTEMPTS):
        response = client.chat.completions.create(
            model=MODEL,
            temperature=TEMPERATURE,
            max_tokens=1_000,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": listing},
            ],
            # deepseek-flash razona por defecto: ~20 veces más tokens por lote, y
            # con este `max_tokens` el razonamiento no deja sitio a la respuesta.
            extra_body={"thinking": {"type": "disabled"}},
        )
        try:
            scores = parse_scores(response.choices[0].message.content or "", len(batch))
        except ScoringError as error:
            last_error = error
            continue
        return {content_key(row["type"], row["tmdb_id"]): score for row, score in zip(batch, scores)}
    raise ScoringError(f"lote de {batch[0]['title_en']!r}: {last_error}")


def load_scores() -> dict[str, dict[int, int]]:
    """Clave → pasada → puntuación, solo de la versión actual del prompt."""
    scores: dict[str, dict[int, int]] = {}
    for row in read_jsonl(SCORES_PATH):
        if row["version"] == PROMPT_VERSION and "pass" in row:
            scores.setdefault(row["key"], {})[row["pass"]] = row["score"]
    return scores


def pass_batches(pass_number: int, pending: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Lotes barajados con la pasada como semilla: otra composición en cada una, y la misma al reejecutar."""
    rows = sorted(pending, key=lambda row: (row["type"], row["tmdb_id"]))
    random.Random(pass_number).shuffle(rows)
    return [rows[i : i + BATCH_SIZE] for i in range(0, len(rows), BATCH_SIZE)]


def score_all(universe: list[dict[str, Any]]) -> dict[str, list[int]]:
    scores = load_scores()
    client: OpenAI | None = None
    failures = 0

    for pass_number in range(1, PASSES + 1):
        pending = [row for row in universe if pass_number not in scores.get(content_key(row["type"], row["tmdb_id"]), {})]
        batches = pass_batches(pass_number, pending)
        print(f"  pasada {pass_number}: {len(universe) - len(pending)} en caché (prompt {PROMPT_VERSION}), {len(pending)} por puntuar en {len(batches)} lotes")
        if not batches:
            continue

        client = client or OpenAI(base_url="https://api.deepseek.com", api_key=require_env("DEEPSEEK_API_KEY"), max_retries=5, timeout=120)
        with ThreadPoolExecutor(WORKERS) as pool:
            futures = [pool.submit(score_batch, client, batch) for batch in batches]
            for done, future in enumerate(as_completed(futures), start=1):
                try:
                    result = future.result()
                except (ScoringError, OpenAIError) as error:
                    failures += 1
                    print(f"  ✗ {error}", file=sys.stderr)
                    continue
                append_jsonl(SCORES_PATH, [{"key": k, "version": PROMPT_VERSION, "pass": pass_number, "score": s} for k, s in result.items()])
                for key, score in result.items():
                    scores.setdefault(key, {})[pass_number] = score
                if done % 50 == 0:
                    print(f"    {done}/{len(batches)} lotes")

    if failures:
        raise SystemExit(f"{failures} lotes fallidos. Reejecuta: los ya puntuados no se repiten.")
    return {key: [by_pass[p] for p in sorted(by_pass)] for key, by_pass in scores.items()}


# ─── Selección ───────────────────────────────────────────────────────────────


def label(row: dict[str, Any]) -> str:
    return f"{row['llm_score']:>5.1f}  {row['title']} ({row['year']})"


def report(content_type: str, ranked: list[dict[str, Any]], chosen: int) -> None:
    kept = ranked[:chosen]
    deciles = Counter(min(int(row["llm_score"] // 10), 9) * 10 for row in kept)
    print(f"\n  {content_type}: {len(kept)} al corpus, corte en {kept[-1]['llm_score']:.1f}/100")
    print("  reparto: " + "  ".join(f"{d}–{d + 9}: {deciles[d]}" for d in sorted(deciles, reverse=True)))
    print("  arriba:  " + " · ".join(label(r) for r in kept[:5]))
    print("  el corte: " + " · ".join(label(r) for r in kept[-3:]))
    if len(ranked) > chosen:
        print("  fuera:   " + " · ".join(label(r) for r in ranked[chosen : chosen + 3]))

    # Lo que la media corrige: títulos en los que las pasadas no se ponen de acuerdo.
    spread = sorted(kept, key=lambda row: max(row["llm_scores"]) - min(row["llm_scores"]), reverse=True)
    wide = sum(1 for row in kept if max(row["llm_scores"]) - min(row["llm_scores"]) >= 20)
    print(f"  pasadas que difieren en 20 o más: {wide}. Las que más: "
          + " · ".join(f"{row['title']} {row['llm_scores']}" for row in spread[:3]))


def main() -> None:
    universe = list(read_jsonl(UNIVERSE_PATH))
    if not universe:
        raise SystemExit(f"No hay universo en {UNIVERSE_PATH}. Ejecuta antes fetch-tmdb.py.")
    print(f"{len(universe)} títulos en el universo, {PASSES} pasadas")

    scores = score_all(universe)

    corpus: list[dict[str, Any]] = []
    for content_type in CONTENT_TYPES:
        ranked = []
        for row in universe:
            if row["type"] != content_type:
                continue
            passes = scores[content_key(row["type"], row["tmdb_id"])]
            ranked.append(row | {"llm_scores": passes, "llm_score": round(mean(passes), 1)})
        ranked.sort(key=lambda row: (-row["llm_score"], -row["vote_count"]))

        chosen = min(CORPUS_SIZE[content_type], len(ranked))
        report(content_type, ranked, chosen)
        corpus += [row | {"autumn_score": round(row["llm_score"] / 100, 3)} for row in ranked[:chosen]]

    write_jsonl(CORPUS_PATH, corpus)
    print(f"\n{len(corpus)} títulos → {CORPUS_PATH.relative_to(DATA_DIR.parent)}")


if __name__ == "__main__":
    main()
