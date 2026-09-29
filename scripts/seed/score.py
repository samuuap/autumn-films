"""
Puntúa cuán otoñal es cada título del universo y elige el corpus.

    python score.py

1. Una heurística barata (géneros, keywords, mes de estreno) ordena todo el
   universo. Solo sirve para descartar: pasan los `PREFILTER_FACTOR` × objetivo
   mejores de cada tipo.
2. deepseek-flash puntúa de 0 a 100 los que pasan, por lotes y a temperatura
   0.1. Las puntuaciones se guardan en `data/scores.jsonl` con la versión del
   prompt: reejecutar no repite llamadas y da el mismo corpus, y cambiar el
   prompt invalida la caché por sí solo.
3. Entran al corpus los `CORPUS_SIZE[tipo]` mejor puntuados, con
   `autumn_score = puntuación / 100`.

Necesita `data/universe.jsonl` (fetch-tmdb.py). Produce `data/corpus.jsonl`.
"""

from __future__ import annotations

import hashlib
import json
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
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
PREFILTER_FACTOR = 2

MODEL = "deepseek-flash"
TEMPERATURE = 0.1  # clasificación: lo más estable posible
BATCH_SIZE = 25
WORKERS = 8
MAX_ATTEMPTS = 3
SCORES_PATH = DATA_DIR / "scores.jsonl"

# ─── 1. Heurística ───────────────────────────────────────────────────────────
# Tosca a propósito: solo decide qué no merece una llamada al modelo. Los ids de
# películas y series comparten numeración cuando el género es el mismo.

GENRE_WEIGHTS = {
    27: 2.0,  # Terror
    9648: 2.0,  # Misterio
    14: 1.0,  # Fantasía
    18: 1.0,  # Drama
    10749: 1.0,  # Romance
    80: 0.5,  # Crimen
    53: 0.5,  # Suspense
    10751: 0.5,  # Familia
    36: 0.5,  # Historia
    12: -0.5,  # Aventura
    37: -0.5,  # Western
    10752: -1.0,  # Bélica
    10768: -1.0,  # War & Politics (series)
    99: -1.0,  # Documental
    28: -1.5,  # Acción
    10759: -1.5,  # Action & Adventure (series)
    878: -1.5,  # Ciencia ficción
}

# Subcadenas que no tienen otra lectura que la estacional.
SEASONAL_STEMS = ("autumn", "halloween", "thanksgiving", "pumpkin", "trick or treat", "scarecrow")
SEASONAL_KEYWORDS = {"harvest", "harvest festival", "day of the dead", "dia de los muertos", "fall season"}
AUTUMNAL_KEYWORDS = {
    "small town", "new england", "maine", "vermont", "massachusetts", "salem",
    "boarding school", "private school", "college", "university", "campus", "school",
    "ghost", "ghost story", "haunted house", "haunting", "supernatural", "occult", "seance",
    "witch", "witchcraft", "coven", "vampire", "werewolf",
    "gothic", "gothic horror", "folk horror", "murder mystery", "whodunit", "detective",
    "cabin", "cabin in the woods", "forest", "woods", "rain", "fog",
    "countryside", "village", "english countryside", "manor house", "mansion", "victorian england",
    "literature", "poetry", "poet", "writer", "bookstore", "library",
    "nostalgia", "coming of age", "melancholy", "grief", "family reunion",
}
UNAUTUMNAL_KEYWORDS = {
    "summer", "summer vacation", "beach", "tropical island", "island", "surfing", "spring break",
    "superhero", "superhero team", "based on comic", "marvel cinematic universe (mcu)",
    "dc extended universe (dceu)", "outer space", "space", "spaceship", "space travel",
    "alien invasion", "cyberpunk", "dystopia", "post-apocalyptic future",
    "car race", "street racing", "martial arts", "heist", "desert", "kaiju", "giant monster",
}
WINTER_KEYWORDS = {"christmas", "christmas eve", "santa claus", "snow"}


def heuristic(row: dict[str, Any]) -> float:
    score = sum(GENRE_WEIGHTS.get(genre_id, 0.0) for genre_id in row["genre_ids"])

    positive = negative = 0.0
    for keyword in (k.lower() for k in row["keywords"]):
        if keyword in SEASONAL_KEYWORDS or any(stem in keyword for stem in SEASONAL_STEMS):
            positive += 3.0
        elif keyword in AUTUMNAL_KEYWORDS:
            positive += 1.5
        elif keyword in UNAUTUMNAL_KEYWORDS:
            negative += 2.0
        elif keyword in WINTER_KEYWORDS:
            negative += 1.0
    # Topes: una ficha con 40 keywords no debe ganar solo por tener muchas.
    score += min(positive, 6.0) - min(negative, 4.0)

    month = row["release_month"]
    if month in (9, 10, 11):
        score += 1.0
    elif month in (6, 7, 8):
        score -= 0.5
    return score


# ─── 2. Puntuación con el modelo ─────────────────────────────────────────────

SYSTEM_PROMPT = """\
You score how autumnal films and TV series feel, for a recommendation app that only suggests autumn viewing.

For each title, give an integer from 0 to 100: how well it fits a cold, early-dusk autumn evening. Judge the whole work — setting, atmosphere, themes and the mood it leaves — not just whether it mentions the season.

- 90–100: quintessentially autumnal. Autumn, Halloween, Thanksgiving or the Day of the Dead is central, or the whole work breathes falling leaves, fog, harvest and early nights. E.g. Hocus Pocus, Over the Garden Wall, Dead Poets Society, Gilmore Girls.
- 70–89: strongly autumnal atmosphere or themes: gothic, cozy or classic mysteries, folk horror, ghost stories, witches, New England or small-town life, campuses and boarding schools, rainy cities, melancholy, nostalgia, grief, coming of age. E.g. Knives Out, Sleepy Hollow, Little Women.
- 40–69: fits autumn reasonably well: reflective dramas, thrillers, romances or fantasies with some autumn texture but no seasonal identity.
- 10–39: seasonally neutral or at odds with autumn: mainstream action, bright comedies, most science fiction, stories centred on Christmas or winter.
- 0–9: the opposite of autumn: summer, beaches and tropics, superhero blockbusters, space opera. E.g. Mamma Mia!, Guardians of the Galaxy.

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


def load_scores() -> dict[str, int]:
    return {row["key"]: row["score"] for row in read_jsonl(SCORES_PATH) if row["version"] == PROMPT_VERSION}


def score_all(candidates: list[dict[str, Any]]) -> dict[str, int]:
    scores = load_scores()
    pending = sorted(
        (row for row in candidates if content_key(row["type"], row["tmdb_id"]) not in scores),
        key=lambda row: (row["type"], row["tmdb_id"]),
    )
    batches = [pending[i : i + BATCH_SIZE] for i in range(0, len(pending), BATCH_SIZE)]
    print(f"  {len(candidates) - len(pending)} en caché (prompt {PROMPT_VERSION}), {len(pending)} por puntuar en {len(batches)} lotes")
    if not batches:
        return scores

    client = OpenAI(base_url="https://api.deepseek.com", api_key=require_env("DEEPSEEK_API_KEY"), max_retries=5, timeout=120)
    failures = 0
    with ThreadPoolExecutor(WORKERS) as pool:
        futures = [pool.submit(score_batch, client, batch) for batch in batches]
        for done, future in enumerate(as_completed(futures), start=1):
            try:
                result = future.result()
            except (ScoringError, OpenAIError) as error:
                failures += 1
                print(f"  ✗ {error}", file=sys.stderr)
                continue
            append_jsonl(SCORES_PATH, [{"key": k, "version": PROMPT_VERSION, "score": s} for k, s in result.items()])
            scores |= result
            if done % 20 == 0:
                print(f"    {done}/{len(batches)} lotes")

    if failures:
        raise SystemExit(f"{failures} lotes fallidos. Reejecuta: los ya puntuados no se repiten.")
    return scores


# ─── 3. Selección ────────────────────────────────────────────────────────────


def label(row: dict[str, Any]) -> str:
    return f"{row['llm_score']:>3}  {row['title']} ({row['year']})"


def report(content_type: str, ranked: list[dict[str, Any]], chosen: int) -> None:
    kept = ranked[:chosen]
    deciles = Counter(min(row["llm_score"] // 10, 9) * 10 for row in kept)
    print(f"\n  {content_type}: {len(kept)} al corpus, corte en {kept[-1]['llm_score']}/100")
    print("  reparto: " + "  ".join(f"{d}–{d + 9}: {deciles[d]}" for d in sorted(deciles, reverse=True)))
    print("  arriba:  " + " · ".join(label(r) for r in kept[:5]))
    print("  el corte: " + " · ".join(label(r) for r in kept[-3:]))
    if len(ranked) > chosen:
        print("  fuera:   " + " · ".join(label(r) for r in ranked[chosen : chosen + 3]))


def main() -> None:
    universe = list(read_jsonl(UNIVERSE_PATH))
    if not universe:
        raise SystemExit(f"No hay universo en {UNIVERSE_PATH}. Ejecuta antes fetch-tmdb.py.")

    candidates: list[dict[str, Any]] = []
    for content_type in CONTENT_TYPES:
        rows = [row | {"heuristic": heuristic(row)} for row in universe if row["type"] == content_type]
        rows.sort(key=lambda row: (-row["heuristic"], -row["vote_count"]))
        limit = PREFILTER_FACTOR * CORPUS_SIZE[content_type]
        print(f"{content_type}: {min(limit, len(rows))} de {len(rows)} pasan la heurística")
        candidates += rows[:limit]

    scores = score_all(candidates)

    corpus: list[dict[str, Any]] = []
    for content_type in CONTENT_TYPES:
        ranked = sorted(
            (row | {"llm_score": scores[content_key(row["type"], row["tmdb_id"])]} for row in candidates if row["type"] == content_type),
            key=lambda row: (-row["llm_score"], -row["heuristic"], -row["vote_count"]),
        )
        chosen = min(CORPUS_SIZE[content_type], len(ranked))
        report(content_type, ranked, chosen)
        corpus += [row | {"autumn_score": row["llm_score"] / 100} for row in ranked[:chosen]]

    write_jsonl(CORPUS_PATH, corpus)
    print(f"\n{len(corpus)} títulos → {CORPUS_PATH.relative_to(DATA_DIR.parent)}")


if __name__ == "__main__":
    main()
