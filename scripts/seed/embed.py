"""
Vectoriza el corpus con Qwen3-Embedding.

    python embed.py

Necesita `data/corpus.jsonl` (score.py) y el servicio de embeddings en
`EMBEDDINGS_URL` (en local, `npm run embeddings`). Produce `data/embeddings.jsonl`.

Cada vector se guarda junto al hash del texto del que sale: reejecutar solo
vectoriza los títulos nuevos o cuyo texto ha cambiado, y un corte a mitad se
reanuda sin repetir lotes.
"""

from __future__ import annotations

import math

from openai import APIConnectionError, OpenAI

from common import (
    CORPUS_PATH,
    EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL,
    EMBEDDING_SERVICE_MODEL,
    EMBEDDINGS_PATH,
    append_jsonl,
    content_key,
    document_text,
    optional_env,
    pack_vector,
    read_jsonl,
    require_env,
    text_hash,
    write_jsonl,
)

BATCH_SIZE = 32


def check(vectors: list[list[float]], expected: int) -> None:
    if len(vectors) != expected:
        raise SystemExit(f"El servicio devolvió {len(vectors)} vectores para {expected} textos.")
    for vector in vectors:
        if len(vector) != EMBEDDING_DIMENSIONS:
            raise SystemExit(
                f"Vector de {len(vector)} dimensiones; el esquema espera {EMBEDDING_DIMENSIONS}. "
                f"¿Sirve de verdad {EMBEDDING_MODEL}?"
            )
        if not all(math.isfinite(value) for value in vector):
            raise SystemExit("El servicio devolvió un vector con NaN o infinitos.")


def main() -> None:
    corpus = list(read_jsonl(CORPUS_PATH))
    if not corpus:
        raise SystemExit(f"No hay corpus en {CORPUS_PATH}. Ejecuta antes score.py.")

    # Si una clave aparece varias veces, gana la última línea.
    cache = {row["key"]: row for row in read_jsonl(EMBEDDINGS_PATH)}
    documents = [
        (key, text, text_hash(text))
        for row in corpus
        for key, text in [(content_key(row["type"], row["tmdb_id"]), document_text(row))]
    ]
    pending = [doc for doc in documents if cache.get(doc[0], {}).get("hash") != doc[2]]
    print(f"{len(documents) - len(pending)} vectores en caché, {len(pending)} por generar")

    url = require_env("EMBEDDINGS_URL")
    client = OpenAI(base_url=url, api_key=optional_env("EMBEDDINGS_API_KEY") or "local", timeout=300)
    batches = [pending[i : i + BATCH_SIZE] for i in range(0, len(pending), BATCH_SIZE)]
    for done, batch in enumerate(batches, start=1):
        try:
            response = client.embeddings.create(
                model=EMBEDDING_SERVICE_MODEL, input=[text for _, text, _ in batch], encoding_format="float"
            )
        except APIConnectionError as error:
            raise SystemExit(f"No hay servicio de embeddings en {url}. En local: npm run embeddings") from error
        vectors = [item.embedding for item in sorted(response.data, key=lambda item: item.index)]
        check(vectors, len(batch))
        rows = [{"key": key, "hash": digest, "embedding": pack_vector(v)} for (key, _, digest), v in zip(batch, vectors)]
        append_jsonl(EMBEDDINGS_PATH, rows)
        cache |= {row["key"]: row for row in rows}
        if done % 20 == 0 or done == len(batches):
            print(f"  {done}/{len(batches)} lotes")

    # Compacta: solo el vector vigente de cada título que sigue en el corpus.
    write_jsonl(EMBEDDINGS_PATH, (cache[key] for key, _, _ in documents))
    print(f"{len(documents)} vectores → {EMBEDDINGS_PATH.name}")


if __name__ == "__main__":
    main()
