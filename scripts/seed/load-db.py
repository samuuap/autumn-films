"""
Carga el corpus vectorizado en la tabla `content` de Supabase.

    python load-db.py            # upsert de todo el corpus
    python load-db.py --prune    # y borra de `content` lo que ya no está en el corpus

Usa la secret key, que es la que se salta RLS: `anon` no puede escribir en
`content`. Hace upsert por `(tmdb_id, type)`, así que reejecutar actualiza en vez
de duplicar.

`--prune` borra en cascada los favoritos que apunten a esos títulos. Por eso no
es el comportamiento por defecto.
"""

from __future__ import annotations

import argparse
import json
from typing import Any

from common import (
    CORPUS_PATH,
    EMBEDDINGS_PATH,
    content_key,
    document_text,
    http_session,
    read_jsonl,
    require_env,
    text_hash,
    to_pg_vector,
    unpack_vector,
)

BATCH_SIZE = 100
PAGE_SIZE = 1_000  # el máximo que devuelve PostgREST en Supabase por defecto

COLUMNS = (
    "tmdb_id", "type", "title", "title_en", "year", "director", "synopsis", "synopsis_en",
    "genres", "keywords", "autumn_score", "poster_path", "backdrop_path", "runtime", "seasons", "status",
)

REST = f"{require_env('SUPABASE_URL')}/rest/v1"
session = http_session()
secret = require_env("SUPABASE_SECRET_KEY")
session.headers.update({"apikey": secret, "Authorization": f"Bearer {secret}", "Content-Type": "application/json"})


def request(method: str, path: str, **kwargs: Any) -> Any:
    response = session.request(method, f"{REST}{path}", timeout=120, **kwargs)
    if not response.ok:
        raise SystemExit(f"{method} {path} → {response.status_code}: {response.text[:500]}")
    return response


def build_rows() -> list[dict[str, Any]]:
    """Filas del corpus con su vector, comprobando que el vector es del texto actual."""
    embeddings = {row["key"]: row for row in read_jsonl(EMBEDDINGS_PATH)}
    rows, stale = [], 0
    for item in read_jsonl(CORPUS_PATH):
        embedding = embeddings.get(content_key(item["type"], item["tmdb_id"]))
        if embedding is None or embedding["hash"] != text_hash(document_text(item)):
            stale += 1
            continue
        rows.append({column: item[column] for column in COLUMNS} | {"embedding": to_pg_vector(unpack_vector(embedding["embedding"]))})
    if not rows:
        raise SystemExit(f"No hay corpus en {CORPUS_PATH}. Ejecuta antes score.py y embed.py.")
    if stale:
        raise SystemExit(f"{stale} títulos sin vector o con un vector desfasado. Ejecuta antes embed.py.")
    return rows


def upsert(rows: list[dict[str, Any]]) -> None:
    for start in range(0, len(rows), BATCH_SIZE):
        request(
            "POST",
            "/content",
            params={"on_conflict": "tmdb_id,type"},
            headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
            data=json.dumps(rows[start : start + BATCH_SIZE]),
        )
        print(f"  {min(start + BATCH_SIZE, len(rows))}/{len(rows)}")


def loaded_ids() -> dict[str, str]:
    """`{clave: id}` de todo lo que hay en `content`."""
    ids: dict[str, str] = {}
    offset = 0
    while True:
        page = request(
            "GET", "/content", params={"select": "id,tmdb_id,type", "order": "id", "limit": PAGE_SIZE, "offset": offset}
        ).json()
        ids |= {content_key(row["type"], row["tmdb_id"]): row["id"] for row in page}
        if len(page) < PAGE_SIZE:
            return ids
        offset += PAGE_SIZE


def count(**filters: str) -> int:
    response = request("HEAD", "/content", params={"select": "id", **filters}, headers={"Prefer": "count=exact"})
    return int(response.headers["Content-Range"].split("/")[-1])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--prune", action="store_true", help="borrar de content lo que ya no está en el corpus")
    args = parser.parse_args()

    rows = build_rows()
    print(f"Cargando {len(rows)} títulos en {REST.removesuffix('/rest/v1')}")
    upsert(rows)

    current = {content_key(row["type"], row["tmdb_id"]) for row in rows}
    leftovers = [row_id for key, row_id in loaded_ids().items() if key not in current]
    if leftovers and args.prune:
        for start in range(0, len(leftovers), BATCH_SIZE):
            request("DELETE", "/content", params={"id": f"in.({','.join(leftovers[start : start + BATCH_SIZE])})"})
        print(f"  {len(leftovers)} títulos que ya no están en el corpus, borrados")
    elif leftovers:
        print(f"  ⚠ {len(leftovers)} títulos en la tabla ya no están en el corpus. --prune para borrarlos")

    print("\nEn la tabla")
    print(f"  total        {count():>6}")
    for content_type in ("movie", "tv"):
        print(f"  {content_type:<12} {count(type=f'eq.{content_type}'):>6}")
    for column in ("embedding", "director", "synopsis", "synopsis_en", "poster_path"):
        print(f"  sin {column:<12} {count(**{column: 'is.null'}):>2}")


if __name__ == "__main__":
    main()
