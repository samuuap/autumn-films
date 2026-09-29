"""
Descarga de TMDB el universo de candidatos al corpus.

    python fetch-tmdb.py

1. Descubre los títulos con más votos de cada tipo. Va año a año porque
   `/discover` no pasa de 500 páginas por consulta.
2. Trae el detalle de cada uno (keywords, créditos y traducciones en una sola
   llamada) y lo guarda recortado en `data/details-{tipo}.jsonl`.
3. Lo normaliza al formato del esquema en `data/universe.jsonl`.

El universo es más grande que el corpus: qué entra lo decide `score.py`. Todo lo
descargado queda en caché. Un corte a mitad se reanuda donde se quedó, y
reejecutar con la caché completa solo repite el paso 3. Para volver a descubrir,
borrar `data/discover-*.json`.
"""

from __future__ import annotations

import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from typing import Any

import requests

from common import (
    CONTENT_TYPES,
    DATA_DIR,
    UNIVERSE_PATH,
    append_jsonl,
    http_session,
    read_jsonl,
    require_env,
    write_jsonl,
)

API = "https://api.themoviedb.org/3"

# El universo es de 3 a 4 veces el corpus para que `score.py` tenga donde elegir.
UNIVERSE_SIZE = {"movie": 15_000, "tv": 2_000}
# Suelo de votos al descubrir: por debajo, la puntuación de TMDB es ruido y el
# título suele ser demasiado oscuro para encontrarlo en streaming.
MIN_VOTES = {"movie": 100, "tv": 50}
FIRST_YEAR = 1900
MAX_PAGES = 500
WORKERS = 10

# Noticias, reality, telenovela y talk show: no son series que se recomienden.
TV_EXCLUDED_GENRES = "10763,10764,10766,10767"
# Más de 40 minutos es la definición de largometraje de la Academia.
MIN_MOVIE_RUNTIME = 40

# TMDB deja estos géneros de series en inglés en su lista es-ES.
TV_GENRES_ES = {
    10759: "Acción y aventura",
    10762: "Infantil",
    10765: "Ciencia ficción y fantasía",
    10768: "Bélica y política",
}

TMDB_STATUS = {
    "movie": {"Released": "released"},
    # «In Production» entre temporadas sigue siendo una serie en emisión.
    "tv": {"Returning Series": "ongoing", "In Production": "ongoing", "Ended": "ended", "Canceled": "ended"},
}

session = http_session(pool_size=WORKERS)
session.headers["Authorization"] = f"Bearer {require_env('TMDB_READ_ACCESS_TOKEN')}"


def get(path: str, **params: Any) -> dict[str, Any]:
    response = session.get(f"{API}{path}", params=params, timeout=30)
    response.raise_for_status()
    return response.json()


# ─── 1. Géneros ──────────────────────────────────────────────────────────────


def fetch_genres() -> dict[str, dict[int, dict[str, str]]]:
    """`{tipo: {id: {"en": nombre, "es": nombre}}}`. El detalle solo trae el nombre en un idioma."""
    path = DATA_DIR / "genres.json"
    if not path.exists():
        genres: dict[str, dict[str, dict[str, str]]] = {}
        for content_type in CONTENT_TYPES:
            by_id: dict[str, dict[str, str]] = {}
            for lang, locale in (("en", "en-US"), ("es", "es-ES")):
                for genre in get(f"/genre/{content_type}/list", language=locale)["genres"]:
                    by_id.setdefault(str(genre["id"]), {})[lang] = genre["name"]
            genres[content_type] = by_id
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(genres, ensure_ascii=False, indent=2), encoding="utf-8")
    raw = json.loads(path.read_text(encoding="utf-8"))
    genres = {t: {int(k): v for k, v in by_id.items()} for t, by_id in raw.items()}
    for genre_id, name in TV_GENRES_ES.items():
        genres["tv"][genre_id]["es"] = name
    return genres


# ─── 2. Descubrimiento ───────────────────────────────────────────────────────


def discover_year(content_type: str, year: int) -> list[dict[str, int]]:
    today = date.today().isoformat()
    start, end = f"{year}-01-01", min(f"{year}-12-31", today)
    if content_type == "movie":
        params: dict[str, Any] = {
            "primary_release_date.gte": start,
            "primary_release_date.lte": end,
            "with_runtime.gte": MIN_MOVIE_RUNTIME,
            "include_video": "false",
        }
    else:
        params = {"first_air_date.gte": start, "first_air_date.lte": end, "without_genres": TV_EXCLUDED_GENRES}
    params |= {"sort_by": "vote_count.desc", "vote_count.gte": MIN_VOTES[content_type], "include_adult": "false"}

    found: list[dict[str, int]] = []
    page, total_pages = 1, 1
    while page <= min(total_pages, MAX_PAGES):
        data = get(f"/discover/{content_type}", page=page, **params)
        total_pages = data["total_pages"]
        found += [{"id": r["id"], "vote_count": r["vote_count"]} for r in data["results"]]
        page += 1
    if total_pages > MAX_PAGES:
        print(f"  ⚠ {content_type} {year}: {total_pages} páginas, solo se leen {MAX_PAGES}", file=sys.stderr)
    return found


def discover(content_type: str) -> list[int]:
    """Ids del universo, de más a menos votados."""
    path = DATA_DIR / f"discover-{content_type}.json"
    if not path.exists():
        years = range(FIRST_YEAR, date.today().year + 1)
        with ThreadPoolExecutor(WORKERS) as pool:
            batches = pool.map(lambda year: discover_year(content_type, year), years)
            found = {r["id"]: r for batch in batches for r in batch}
        ranked = sorted(found.values(), key=lambda r: (-r["vote_count"], r["id"]))
        print(f"  {content_type}: {len(ranked)} títulos con ≥{MIN_VOTES[content_type]} votos")
        path.write_text(json.dumps(ranked[: UNIVERSE_SIZE[content_type]]), encoding="utf-8")
    return [r["id"] for r in json.loads(path.read_text(encoding="utf-8"))]


# ─── 3. Detalle ──────────────────────────────────────────────────────────────


def pick_translations(entries: list[dict[str, Any]], title_field: str) -> list[dict[str, str]]:
    return [
        {
            "lang": t["iso_639_1"],
            "region": t["iso_3166_1"],
            "title": (t["data"].get(title_field) or "").strip(),
            "overview": (t["data"].get("overview") or "").strip(),
        }
        for t in entries
        if t["iso_639_1"] in ("en", "es")
    ]


def trim(content_type: str, d: dict[str, Any]) -> dict[str, Any]:
    """Solo lo que usa el pipeline. Los créditos completos pesan decenas de KB por título."""
    common = {
        "id": d["id"],
        "adult": d.get("adult", False),
        "original_language": d.get("original_language"),
        "status": d.get("status"),
        "genre_ids": [g["id"] for g in d.get("genres", [])],
        "poster_path": d.get("poster_path"),
        "backdrop_path": d.get("backdrop_path"),
        "vote_count": d.get("vote_count", 0),
        "vote_average": d.get("vote_average"),
        "popularity": d.get("popularity"),
    }
    if content_type == "movie":
        return common | {
            "original_title": d.get("original_title"),
            "date": d.get("release_date"),
            "runtime": d.get("runtime"),
            "keywords": [k["name"] for k in d["keywords"]["keywords"]],
            "directors": [c["name"] for c in d["credits"]["crew"] if c.get("job") == "Director"],
            "translations": pick_translations(d["translations"]["translations"], "title"),
        }
    last_episode = d.get("last_episode_to_air") or {}
    return common | {
        "original_title": d.get("original_name"),
        "date": d.get("first_air_date"),
        "runtime": (d.get("episode_run_time") or [None])[0] or last_episode.get("runtime"),
        "seasons": d.get("number_of_seasons"),
        # En series no hay un director: quien la crea es el equivalente.
        "directors": [c["name"] for c in d.get("created_by", [])],
        "keywords": [k["name"] for k in d["keywords"]["results"]],
        "translations": pick_translations(d["translations"]["translations"], "name"),
    }


def fetch_detail(content_type: str, tmdb_id: int) -> dict[str, Any]:
    append = "keywords,credits,translations" if content_type == "movie" else "keywords,translations"
    try:
        # es-ES para que `poster_path` sea el cartel en español cuando exista.
        data = get(f"/{content_type}/{tmdb_id}", language="es-ES", append_to_response=append)
    except requests.HTTPError as error:
        if error.response is not None and error.response.status_code == 404:
            return {"id": tmdb_id, "missing": True}
        raise
    return trim(content_type, data)


def fetch_details(content_type: str, ids: list[int]) -> dict[int, dict[str, Any]]:
    path = DATA_DIR / f"details-{content_type}.jsonl"
    cached = {row["id"]: row for row in read_jsonl(path)}
    pending = [tmdb_id for tmdb_id in ids if tmdb_id not in cached]
    print(f"  {content_type}: {len(cached)} en caché, {len(pending)} por descargar")

    failures = 0
    with ThreadPoolExecutor(WORKERS) as pool:
        futures = {pool.submit(fetch_detail, content_type, tmdb_id): tmdb_id for tmdb_id in pending}
        for done, future in enumerate(as_completed(futures), start=1):
            try:
                row = future.result()
            except requests.RequestException as error:
                failures += 1
                print(f"  ✗ {content_type} {futures[future]}: {error}", file=sys.stderr)
                continue
            # Se escribe desde este hilo, uno a uno: un corte pierde como mucho una línea.
            append_jsonl(path, [row])
            cached[row["id"]] = row
            if done % 500 == 0:
                print(f"    {done}/{len(pending)}")

    if failures:
        raise SystemExit(f"{failures} descargas fallidas en {content_type}. Reejecuta para reintentarlas.")
    return cached


# ─── 4. Normalización ────────────────────────────────────────────────────────


def translated(detail: dict[str, Any], lang: str, field: str) -> str | None:
    """Texto en `lang`, prefiriendo España o EE. UU. frente a otras regiones.

    En la traducción del idioma original TMDB deja el título vacío: el título
    real está en `original_title`.
    """
    preferred = {"es": "ES", "en": "US"}[lang]
    entries = sorted((t for t in detail["translations"] if t["lang"] == lang), key=lambda t: t["region"] != preferred)
    for entry in entries:
        if entry[field]:
            return entry[field]
    if field == "title" and detail["original_language"] == lang:
        return detail["original_title"]
    return None


def normalize(
    content_type: str, detail: dict[str, Any], genres: dict[int, dict[str, str]]
) -> dict[str, Any] | None:
    """Fila del universo, o `None` si el título no se puede recomendar."""
    status = TMDB_STATUS[content_type].get(detail["status"] or "")
    synopsis = translated(detail, "es", "overview")
    synopsis_en = translated(detail, "en", "overview")
    if detail["adult"] or status is None or not (synopsis or synopsis_en):
        # Sin sinopsis no hay nada que vectorizar ni que contar al usuario.
        return None

    title_en = translated(detail, "en", "title") or detail["original_title"]
    known_genres = [genres[g] for g in detail["genre_ids"] if g in genres]
    release = detail["date"] or ""
    return {
        "tmdb_id": detail["id"],
        "type": content_type,
        "title": translated(detail, "es", "title") or title_en,
        "title_en": title_en,
        "year": int(release[:4]) if release[:4].isdigit() else None,
        "director": ", ".join(dict.fromkeys(detail["directors"])) or None,
        "synopsis": synopsis,
        "synopsis_en": synopsis_en,
        # Géneros en español para mostrar; en inglés para vectorizar, como las keywords.
        "genres": [g["es"] for g in known_genres],
        "genres_en": [g["en"] for g in known_genres],
        "genre_ids": detail["genre_ids"],
        # TMDB solo tiene keywords en inglés.
        "keywords": detail["keywords"],
        "poster_path": detail["poster_path"],
        "backdrop_path": detail["backdrop_path"],
        "runtime": detail["runtime"] or None,
        "seasons": detail.get("seasons"),
        "status": status,
        "release_month": int(release[5:7]) if release[5:7].isdigit() else None,
        "original_language": detail["original_language"],
        "vote_count": detail["vote_count"],
        "vote_average": detail["vote_average"],
    }


def main() -> None:
    genres = fetch_genres()
    universe: list[dict[str, Any]] = []
    for content_type in CONTENT_TYPES:
        print(f"\n{content_type}")
        ids = discover(content_type)
        details = fetch_details(content_type, ids)
        rows = [
            row
            for tmdb_id in ids
            if not (detail := details[tmdb_id]).get("missing")
            and (row := normalize(content_type, detail, genres[content_type])) is not None
        ]
        print(f"  {len(rows)} recomendables de {len(ids)} (el resto: sin sinopsis, sin estrenar o borrados)")
        universe += rows

    write_jsonl(UNIVERSE_PATH, universe)
    print(f"\n{len(universe)} títulos → {UNIVERSE_PATH.relative_to(DATA_DIR.parent)}")


if __name__ == "__main__":
    main()
