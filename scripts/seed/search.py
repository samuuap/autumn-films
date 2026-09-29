"""
Búsquedas de control contra el corpus cargado.

    python search.py "tarde de lluvia, algo melancólico" "quiero pasar miedo"
    python search.py --type tv "misterio en un pueblo pequeño"

Vectoriza la consulta como lo hará `/api/chat` (con instrucción) y llama a
`search_content` con la publishable key, igual que un cliente anónimo. Pide sin
umbral de similitud para ver dónde caen los valores reales, y avisa si la
función devuelve menos filas de las pedidas.
"""

from __future__ import annotations

import argparse
import json

from openai import OpenAI

from common import (
    EMBEDDING_MODEL,
    format_query,
    http_session,
    normalize_for_embedding,
    optional_env,
    require_env,
    to_pg_vector,
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("queries", nargs="+")
    parser.add_argument("--type", choices=("movie", "tv"))
    parser.add_argument("--count", type=int, default=10)
    args = parser.parse_args()

    embeddings = OpenAI(base_url=require_env("EMBEDDINGS_URL"), api_key=optional_env("EMBEDDINGS_API_KEY") or "local")
    publishable = require_env("SUPABASE_PUBLISHABLE_KEY")
    session = http_session()
    session.headers.update({"apikey": publishable, "Authorization": f"Bearer {publishable}", "Content-Type": "application/json"})

    for query in args.queries:
        vector = embeddings.embeddings.create(
            model=EMBEDDING_MODEL, input=[format_query(normalize_for_embedding(query))], encoding_format="float"
        ).data[0].embedding
        response = session.post(
            f"{require_env('SUPABASE_URL')}/rest/v1/rpc/search_content",
            data=json.dumps(
                {"query_embedding": to_pg_vector(vector), "content_type": args.type, "match_count": args.count, "min_score": -1}
            ),
            timeout=30,
        )
        response.raise_for_status()
        results = response.json()

        print(f"\n«{query}»" + (f"  [{args.type}]" if args.type else ""))
        for rank, row in enumerate(results, start=1):
            director = f" — {row['director']}" if row["director"] else ""
            print(
                f"  {rank:>2}. {row['similarity']:.3f}  otoño {row['autumn_score']:.2f}  "
                f"{row['type']:<5} {row['title']} ({row['year']}){director}"
            )
        if len(results) < args.count:
            print(f"  ⚠ {len(results)} resultados de {args.count} pedidos")


if __name__ == "__main__":
    main()
