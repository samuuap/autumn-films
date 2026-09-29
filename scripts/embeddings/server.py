"""
Servidor local de Qwen3-Embedding con la API de embeddings de OpenAI.

Sustituye al contenedor de Text Embeddings Inference en máquinas sin Docker. El
contrato es el mismo (`POST /v1/embeddings`), así que ni `src/lib/embeddings.ts`
ni los scripts de seed saben qué hay detrás: pasar a TEI o a un endpoint
gestionado sigue siendo cambiar `EMBEDDINGS_URL`.

    npm run embeddings        # o: .venv/bin/python scripts/embeddings/server.py

No añade la instrucción de tarea. Eso lo decide el cliente, que es quien sabe si
el texto es una consulta o un documento.
"""

from __future__ import annotations

import argparse
import base64
import threading
from typing import Literal

import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

MODEL_ID = "Qwen/Qwen3-Embedding-0.6B"
DIMENSIONS = 1024
MAX_INPUTS_PER_REQUEST = 256
# Los clientes recortan a 8.000 caracteres (~2.000 tokens). Este tope solo
# acota la memoria si alguien manda un texto enorme.
MAX_SEQ_LENGTH = 8192


class EmbeddingRequest(BaseModel):
    input: str | list[str]
    model: str = MODEL_ID
    # El SDK de OpenAI pide base64 por defecto y lo decodifica él mismo.
    encoding_format: Literal["float", "base64"] = "float"


def pick_device() -> str:
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def load_model(device: str) -> SentenceTransformer:
    # Relleno a la izquierda, como indica la ficha del modelo: el pooling es por
    # último token y así ese token es siempre el último real de la secuencia.
    # float32 explícito: transformers carga por defecto el bfloat16 del
    # checkpoint, y eso mete ruido de ~1e-3 que hace que el mismo texto dé
    # vectores distintos según con qué otros textos vaya en el lote.
    model = SentenceTransformer(
        MODEL_ID,
        device=device,
        processor_kwargs={"padding_side": "left"},
        model_kwargs={"dtype": torch.float32},
    )
    model.max_seq_length = MAX_SEQ_LENGTH
    dims = model.get_embedding_dimension()
    if dims != DIMENSIONS:
        raise RuntimeError(f"{MODEL_ID} devuelve {dims} dimensiones y el esquema espera {DIMENSIONS}.")
    return model


def encode_vector(vector: np.ndarray, encoding_format: str) -> list[float] | str:
    if encoding_format == "base64":
        return base64.b64encode(vector.astype("<f4").tobytes()).decode("ascii")
    return vector.tolist()


def build_app(model: SentenceTransformer) -> FastAPI:
    app = FastAPI(title="Umber · embeddings")
    # El modelo no es seguro entre hilos y FastAPI atiende los endpoints
    # síncronos en un pool: serializamos la inferencia.
    lock = threading.Lock()

    @app.get("/v1/models")
    def list_models() -> dict[str, object]:
        return {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "owned_by": "local"}]}

    @app.post("/v1/embeddings")
    def create_embeddings(request: EmbeddingRequest) -> dict[str, object]:
        if request.model != MODEL_ID:
            raise HTTPException(404, f"Este servidor solo sirve {MODEL_ID}, no «{request.model}».")
        texts = [request.input] if isinstance(request.input, str) else request.input
        if not texts:
            raise HTTPException(422, "No hay textos que vectorizar.")
        if len(texts) > MAX_INPUTS_PER_REQUEST:
            raise HTTPException(422, f"Como máximo {MAX_INPUTS_PER_REQUEST} textos por petición.")
        if any(not text.strip() for text in texts):
            raise HTTPException(422, "No se puede vectorizar un texto vacío.")

        with lock:
            vectors = model.encode(
                texts, batch_size=32, normalize_embeddings=True, convert_to_numpy=True
            )
            tokens = sum(len(ids) for ids in model.tokenizer(texts)["input_ids"])

        return {
            "object": "list",
            "data": [
                {"object": "embedding", "index": index, "embedding": encode_vector(vector, request.encoding_format)}
                for index, vector in enumerate(vectors)
            ],
            "model": MODEL_ID,
            "usage": {"prompt_tokens": tokens, "total_tokens": tokens},
        }

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()

    device = pick_device()
    print(f"Cargando {MODEL_ID} en {device}…", flush=True)
    model = load_model(device)
    uvicorn.run(build_app(model), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
