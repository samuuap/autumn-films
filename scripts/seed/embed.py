"""
Vectoriza el corpus con Qwen3-Embedding.

    python embed.py

Necesita `data/corpus.jsonl` (score.py) y el servicio de embeddings en
`EMBEDDINGS_URL` (en local, `npm run embeddings`). Produce dos juegos:

- `data/embeddings.jsonl`: el de la búsqueda (`document_text`), que va a
  `content.embedding`.
- `data/plot-embeddings.jsonl`: lo que cuenta cada título sin su nombre
  (`plot_text`). No va a la base: `load-db.py` lo usa para calcular los
  parecidos de cada título («Más como esta»).

Cada vector se guarda junto al hash del texto del que sale: reejecutar solo
vectoriza los títulos nuevos o cuyo texto ha cambiado, y un corte a mitad se
reanuda sin repetir lotes.
"""

from __future__ import annotations

import math
from pathlib import Path

from openai import APIConnectionError, OpenAI

from common import (
    CORPUS_PATH,
    EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL,
    EMBEDDING_SERVICE_MODEL,
    EMBEDDINGS_PATH,
    PLOT_EMBEDDINGS_PATH,
    append_jsonl,
    content_key,
    document_text,
    optional_env,
    pack_vector,
    plot_text,
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


def embed_texts(client: OpenAI, url: str, label: str, path: Path, texts: list[tuple[str, str]]) -> None:
    """Vectoriza los `(clave, texto)` que no estén ya en `path` con el mismo texto, y lo compacta."""
    # Si una clave aparece varias veces, gana la última línea.
    cache = {row["key"]: row for row in read_jsonl(path)}
    documents = [(key, text, text_hash(text)) for key, text in texts]
    pending = [doc for doc in documents if cache.get(doc[0], {}).get("hash") != doc[2]]
    print(f"{label}: {len(documents) - len(pending)} vectores en caché, {len(pending)} por generar")

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
        append_jsonl(path, rows)
        cache |= {row["key"]: row for row in rows}
        if done % 20 == 0 or done == len(batches):
            print(f"  {done}/{len(batches)} lotes", flush=True)

    # Compacta: solo el vector vigente de cada título que sigue en el corpus.
    write_jsonl(path, (cache[key] for key, _, _ in documents))
    print(f"{len(documents)} vectores → {path.name}")


def main() -> None:
    corpus = list(read_jsonl(CORPUS_PATH))
    if not corpus:
        raise SystemExit(f"No hay corpus en {CORPUS_PATH}. Ejecuta antes score.py.")

    url = require_env("EMBEDDINGS_URL")
    client = OpenAI(base_url=url, api_key=optional_env("EMBEDDINGS_API_KEY") or "local", timeout=300)
    keys = [content_key(row["type"], row["tmdb_id"]) for row in corpus]
    embed_texts(client, url, "Búsqueda", EMBEDDINGS_PATH, [(k, document_text(row)) for k, row in zip(keys, corpus)])
    embed_texts(client, url, "Parecidos", PLOT_EMBEDDINGS_PATH, [(k, plot_text(row)) for k, row in zip(keys, corpus)])


if __name__ == "__main__":
    main()
