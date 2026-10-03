"""Piezas compartidas por los scripts de seed: entorno, rutas, HTTP, JSONL y vectores."""

from __future__ import annotations

import array
import base64
import hashlib
import json
import os
import re
import unicodedata
from collections.abc import Iterable, Iterator
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(__file__).resolve().parent / "data"

# Artefactos del pipeline, en orden de producción.
UNIVERSE_PATH = DATA_DIR / "universe.jsonl"  # fetch-tmdb.py
CORPUS_PATH = DATA_DIR / "corpus.jsonl"  # score.py
EMBEDDINGS_PATH = DATA_DIR / "embeddings.jsonl"  # embed.py
PLOT_EMBEDDINGS_PATH = DATA_DIR / "plot-embeddings.jsonl"  # embed.py

CONTENT_TYPES = ("movie", "tv")

# Debe coincidir con `src/lib/embeddings.ts`. Los documentos se vectorizan aquí y
# las consultas allí: si la normalización o la instrucción divergen, la búsqueda
# se degrada sin dar ningún error.
EMBEDDING_MODEL = "Qwen/Qwen3-Embedding-0.6B"
EMBEDDING_DIMENSIONS = 1024
EMBEDDING_MAX_CHARS = 8000
EMBEDDING_TASK = (
    "Given a description of how a viewer feels or what they feel like watching, "
    "retrieve a film or series whose tone and story match that mood"
)

load_dotenv(ROOT / ".env.local")

# Cómo llama el servicio al modelo: `@cf/qwen/qwen3-embedding-0.6b` en Cloudflare,
# el nombre de Hugging Face en el servidor local. Da los mismos vectores en los
# dos (check-embeddings.py), así que `text_hash` sigue usando EMBEDDING_MODEL:
# cambiar de servicio no obliga a volver a vectorizar el corpus.
EMBEDDING_SERVICE_MODEL = os.environ.get("EMBEDDINGS_MODEL", "").strip() or EMBEDDING_MODEL


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"Falta {name} en .env.local")
    return value


def optional_env(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or None


def http_session(pool_size: int = 16) -> requests.Session:
    """Sesión con reintentos y backoff exponencial ante 429 y 5xx, respetando `Retry-After`."""
    retry = Retry(
        total=8,
        backoff_factor=1,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=None,
        respect_retry_after_header=True,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=pool_size, pool_maxsize=pool_size)
    session = requests.Session()
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def read_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    """Lee un JSONL tolerando una última línea a medias, que es lo que deja un corte."""
    if not path.exists():
        return
    with path.open(encoding="utf-8") as file:
        for line in file:
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def append_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as file:
        for row in rows:
            file.write(json.dumps(row, ensure_ascii=False) + "\n")


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    """Escritura atómica: o queda el archivo completo o el anterior."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as file:
        for row in rows:
            file.write(json.dumps(row, ensure_ascii=False) + "\n")
    tmp.replace(path)


def content_key(content_type: str, tmdb_id: int) -> str:
    """Identidad de un título: el id de TMDB solo es único junto con el tipo."""
    return f"{content_type}:{tmdb_id}"


def normalize_for_embedding(text: str) -> str:
    """Igual que `normalizeForEmbedding` en TypeScript: colapsa espacios, recorta y trunca."""
    return re.sub(r"\s+", " ", text).strip()[:EMBEDDING_MAX_CHARS]


def format_query(text: str) -> str:
    """Igual que `formatQuery` en TypeScript. Solo para consultas, nunca para documentos."""
    return f"Instruct: {EMBEDDING_TASK}\nQuery:{text}"


DOCUMENT_KEYWORD_LIMIT = 20

# «Más como esta» (load-db.py): de los SIMILAR_POOL más parecidos, los
# SIMILAR_COUNT primeros tras reordenar como el chat. AUTUMN_WEIGHT tiene que
# coincidir con el de `src/lib/search.ts`.
AUTUMN_WEIGHT = 0.2
SIMILAR_POOL = 24
SIMILAR_COUNT = 12


def comparable_title(title: str) -> str:
    """Sin tildes, mayúsculas ni puntuación: «It (Eso)» e «It» siguen siendo distintos, «IT» e «It» no."""
    stripped = "".join(c for c in unicodedata.normalize("NFD", title) if unicodedata.category(c) != "Mn")
    return re.sub(r"[^\w]+", " ", stripped.lower()).strip()


def document_text(row: dict[str, Any]) -> str:
    """Texto canónico que se vectoriza de cada título. Va sin instrucción: es un documento.

    En inglés, con la sinopsis española solo si falta la inglesa: TMDB tiene las
    keywords únicamente en inglés y sus sinopsis inglesas son más completas.

    Lleva también el título español cuando no es el mismo (3.944 de 5.000): sin
    él, «Cadena perpetua» o «Perdida» no encontraban *The Shawshank Redemption*
    ni *Gone Girl*. Es el título oficial de TMDB, no una traducción.
    """
    year = f" ({row['year']})" if row["year"] else ""
    parts = [f"{row['title_en']}{year}."]
    if comparable_title(row["title"]) != comparable_title(row["title_en"]):
        parts.append(f"Spanish title: {row['title']}.")
    parts.append(row["synopsis_en"] or row["synopsis"])
    if row["genres_en"]:
        parts.append(f"Genres: {', '.join(row['genres_en'])}.")
    if row["keywords"]:
        parts.append(f"Keywords: {', '.join(row['keywords'][:DOCUMENT_KEYWORD_LIMIT])}.")
    return normalize_for_embedding(" ".join(parts))


def plot_text(row: dict[str, Any]) -> str:
    """Lo que cuenta un título, sin su nombre ni su año: con este texto se comparan
    títulos entre sí («Más como esta»). Va sin instrucción, como `document_text`.

    Con el nombre dentro, dos títulos se parecían por cómo se llaman: *Cuando
    Harry encontró a Sally* salía junto a *Harry, un amigo que os quiere*, que es
    un thriller. Para buscar por ánimo no molesta; para comparar títulos, sí.
    """
    parts = [row["synopsis_en"] or row["synopsis"]]
    if row["genres_en"]:
        parts.append(f"Genres: {', '.join(row['genres_en'])}.")
    if row["keywords"]:
        parts.append(f"Keywords: {', '.join(row['keywords'][:DOCUMENT_KEYWORD_LIMIT])}.")
    return normalize_for_embedding(" ".join(parts))


def text_hash(text: str) -> str:
    """Identifica el texto y el modelo: si cambia cualquiera de los dos, el vector ya no vale."""
    return hashlib.sha256(f"{EMBEDDING_MODEL}\n{text}".encode()).hexdigest()[:16]


def pack_vector(vector: list[float]) -> str:
    """float32 en base64: un tercio de lo que ocupa en JSON y sin perder precisión."""
    return base64.b64encode(array.array("f", vector).tobytes()).decode("ascii")


def unpack_vector(packed: str) -> list[float]:
    return array.array("f", base64.b64decode(packed)).tolist()


def to_pg_vector(vector: list[float]) -> str:
    """Literal de pgvector, como `toPgVector` en TypeScript. 9 cifras bastan para un float32."""
    return "[" + ",".join(f"{value:.9g}" for value in vector) + "]"
