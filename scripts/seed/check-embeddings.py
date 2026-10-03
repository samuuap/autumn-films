"""
Comprueba que un servicio de embeddings da los mismos vectores que indexaron el
corpus. Hay que pasarlo antes de apuntar `EMBEDDINGS_URL` a un servicio nuevo.

    python scripts/seed/check-embeddings.py                 # el de .env.local
    python scripts/seed/check-embeddings.py --url … --key … --model …

Sin argumentos usa `EMBEDDINGS_URL`, `EMBEDDINGS_API_KEY` y `EMBEDDINGS_MODEL`
de `.env.local`. Vectoriza 20 documentos del
corpus con su texto canónico y los compara con los de `data/embeddings.jsonl`:
la similitud coseno de cada uno tiene que llegar a `MIN_COSINE`. Si no llega, el
servicio sirve otro modelo, otra precisión (bfloat16 frente a float32) u otras
versiones de librerías, y la búsqueda se degradaría sin dar ningún error.

Mide también lo que tarda una consulta, que es lo que espera cada mensaje del chat.
"""

from __future__ import annotations

import argparse
import math
import random
import time

from openai import APIConnectionError, AuthenticationError, OpenAI

from common import (
    CORPUS_PATH,
    EMBEDDING_SERVICE_MODEL,
    EMBEDDINGS_PATH,
    content_key,
    document_text,
    format_query,
    normalize_for_embedding,
    optional_env,
    require_env,
    read_jsonl,
    text_hash,
    unpack_vector,
)

SAMPLE_SIZE = 20
# Entre CPU y MPS, en float32, las diferencias son de redondeo (~1e-6). Por
# debajo de esto ya no es el mismo cálculo: bfloat16 daba 0,9996 consigo mismo.
MIN_COSINE = 0.9999


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    return dot / (math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b)))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", help="base de la API, acabada en /v1; por defecto, EMBEDDINGS_URL")
    parser.add_argument("--key", help="clave del servicio; por defecto, EMBEDDINGS_API_KEY")
    parser.add_argument("--model", help="nombre del modelo en el servicio; por defecto, EMBEDDINGS_MODEL")
    args = parser.parse_args()

    stored = {row["key"]: row for row in read_jsonl(EMBEDDINGS_PATH)}
    corpus = [row for row in read_jsonl(CORPUS_PATH) if content_key(row["type"], row["tmdb_id"]) in stored]
    if not corpus:
        raise SystemExit("No hay corpus vectorizado en data/: ejecuta antes score.py y embed.py.")

    # Siempre la misma muestra, para poder comparar dos ejecuciones.
    sample = random.Random(0).sample(corpus, min(SAMPLE_SIZE, len(corpus)))
    texts = [document_text(row) for row in sample]
    for row, text in zip(sample, texts):
        if stored[content_key(row["type"], row["tmdb_id"])]["hash"] != text_hash(text):
            raise SystemExit("data/embeddings.jsonl no corresponde al corpus actual: ejecuta embed.py.")

    url = args.url or require_env("EMBEDDINGS_URL")
    model = args.model or EMBEDDING_SERVICE_MODEL
    print(f"{url} · {model}")
    client = OpenAI(base_url=url, api_key=args.key or optional_env("EMBEDDINGS_API_KEY") or "local", timeout=300)
    try:
        started = time.perf_counter()
        response = client.embeddings.create(model=model, input=texts, encoding_format="float")
        batch_seconds = time.perf_counter() - started
    except AuthenticationError as error:
        raise SystemExit(f"El servicio rechaza la clave: {error}") from error
    except APIConnectionError as error:
        raise SystemExit(f"No hay servicio en {url}. En local: npm run embeddings") from error

    vectors = [item.embedding for item in sorted(response.data, key=lambda item: item.index)]
    similarities = [
        cosine(vector, unpack_vector(stored[content_key(row["type"], row["tmdb_id"])]["embedding"]))
        for row, vector in zip(sample, vectors)
    ]
    worst = min(similarities)
    print(f"{len(sample)} documentos en {batch_seconds:.1f} s · similitud con el corpus: mínima {worst:.6f}, media {sum(similarities) / len(similarities):.6f}")

    timings = []
    for query in ("Está lloviendo y estoy melancólico", "Something cozy for a rainy evening", "Quiero pasar miedo esta noche"):
        started = time.perf_counter()
        client.embeddings.create(model=model, input=[format_query(normalize_for_embedding(query))], encoding_format="float")
        timings.append(time.perf_counter() - started)
    print("consulta: " + ", ".join(f"{t * 1000:.0f} ms" for t in timings) + " (la primera puede incluir el arranque)")

    if worst < MIN_COSINE:
        raise SystemExit(f"✗ Vectores distintos (mínima {worst:.6f} < {MIN_COSINE}): no apuntes EMBEDDINGS_URL a este servicio.")
    print("✓ Mismos vectores que el corpus: se puede usar como EMBEDDINGS_URL.")


if __name__ == "__main__":
    main()
