# CLAUDE.md — Proyecto Umber 🍂

Planificador cinematográfico otoñal con IA. Chat conversacional que recomienda películas y series según el estado de ánimo del usuario, usando DeepSeek + búsqueda semántica sobre un corpus de ~5.000 títulos vectorizados en Supabase pgvector.

---

## Stack

| Capa | Tecnología |
|---|---|
| Frontend | Astro + Tailwind CSS |
| LLM | DeepSeek-V4.1-Flash (`deepseek-flash`) |
| Embeddings | Qwen3-Embedding-0.6B autoalojado (1024 dim, endpoint OpenAI-compatible) |
| Base de datos | Supabase (PostgreSQL + pgvector) |
| Auth | Supabase Auth |
| Datos de cine | TMDB API v3 |
| Deploy | Vercel |

---

## Estructura del proyecto

```
/
├── src/
│   ├── components/          # Componentes Astro y UI
│   ├── layouts/
│   │   └── Layout.astro     # Layout base: tema, tipografías, metadatos
│   ├── pages/
│   │   ├── index.astro      # Pantalla de inicio — selector de modo
│   │   ├── chat.astro       # Página del chat
│   │   └── api/
│   │       ├── chat.ts      # Endpoint principal — llama a DeepSeek
│   │       ├── search.ts    # Búsqueda semántica en Supabase pgvector
│   │       └── tmdb.ts      # Proxy para TMDB API
│   ├── lib/
│   │   ├── env.ts           # Único acceso a variables de entorno (servidor)
│   │   ├── env.client.ts    # Variables públicas para el navegador
│   │   ├── errors.ts        # Jerarquía de errores tipados
│   │   ├── types.ts         # Tipos de dominio y los 4 modos
│   │   ├── database.types.ts  # Tipos de las tablas de Supabase
│   │   ├── deepseek.ts      # Cliente DeepSeek (compatible con SDK OpenAI)
│   │   ├── supabase.ts      # Clientes Supabase (anon / usuario / service)
│   │   ├── tmdb.ts          # Funciones TMDB
│   │   └── embeddings.ts    # Generación de embeddings (Qwen3 autoalojado)
│   ├── prompts/
│   │   ├── system.md        # System prompt de Umber (identidad, tono, reglas)
│   │   └── user-context.md  # Plantilla del user prompt con {{variables}}
│   └── styles/
│       └── global.css       # Tailwind + tema otoñal
├── scripts/
│   ├── verify-schema.mjs    # Comprueba esquema y RLS vía Data API
│   ├── embeddings/
│   │   └── server.py        # Qwen3-Embedding local con la API de OpenAI (sin Docker)
│   └── seed/
│       ├── common.py        # Entorno, HTTP, JSONL y el texto canónico de cada título
│       ├── fetch-tmdb.py    # Descarga el universo de candidatos de TMDB
│       ├── score.py         # autumn_score (heurística + deepseek-flash) y selección
│       ├── embed.py         # Vectoriza el corpus con Qwen3
│       ├── load-db.py       # Upsert del corpus en Supabase pgvector
│       └── search.py        # Búsquedas de control contra el corpus cargado
├── supabase/
│   ├── config.toml          # Configuración del CLI
│   └── migrations/          # Esquema versionado, en orden de aplicación
├── docs/                    # Estado del trabajo por fases (ver abajo)
├── public/
├── .claude/CLAUDE.md
└── .env.local               # Nunca al repositorio
```

## Estado del proyecto

El seguimiento del trabajo vive en [`docs/`](../docs/README.md), un archivo por
fase con lo hecho, lo pendiente, las decisiones tomadas con su motivo y las
preguntas abiertas. Antes de empezar a trabajar, leer el archivo de la fase
correspondiente; al cerrar una fase, actualizarlo.

Este documento es la fuente de verdad **técnica**; `docs/` es la del **estado**.
Una decisión que cambie el esquema o el stack va a los dos sitios.

---

## Variables de entorno

```bash
DEEPSEEK_API_KEY=          # Solo chat: DeepSeek no tiene endpoint de embeddings

EMBEDDINGS_URL=            # Servidor OpenAI-compatible con Qwen3-Embedding-0.6B
EMBEDDINGS_API_KEY=        # Solo si ese servicio está autenticado

SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=      # Solo scripts de seed y endpoints de servidor

TMDB_API_KEY=
TMDB_READ_ACCESS_TOKEN=

PUBLIC_APP_URL=
```

`SUPABASE_SECRET_KEY` nunca en el cliente, solo en servidor y scripts de administración.

Los nombres siguen la nomenclatura actual del dashboard de Supabase
(`sb_publishable_…` / `sb_secret_…`). En proyectos antiguos las mismas claves
aparecen etiquetadas como `anon public` y `service_role`.

---

## Comandos

```bash
npm run dev        # Desarrollo local
npm run build      # Build de producción
npm run preview    # Preview del build
npm run typecheck  # astro check
npm run embeddings # Qwen3-Embedding local en EMBEDDINGS_URL (necesita .venv, ver seed)

# Base de datos (migraciones versionadas en supabase/migrations/)
npx supabase login                                  # una vez, abre el navegador
npx supabase link --project-ref <ref-del-proyecto>  # una vez
npm run db:push    # aplica las migraciones pendientes
npm run db:verify  # comprueba esquema, RLS y restricciones vía Data API
npm run db:verify-rls  # comprueba el aislamiento entre dos usuarios reales
npm run db:types   # regenera src/lib/database.types.ts desde el esquema real

# Seed del corpus (una vez, o para actualizaciones). Python ≥ 3.10: el del sistema es 3.9
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r scripts/embeddings/requirements.txt -r scripts/seed/requirements.txt
npm run embeddings                  # en otra terminal
python scripts/seed/fetch-tmdb.py   # universo de ~17.000 títulos de TMDB
python scripts/seed/score.py        # autumn_score y selección de los ~5.000
python scripts/seed/embed.py        # vectoriza el corpus
python scripts/seed/load-db.py      # upsert en Supabase (--prune borra lo que sobra)
python scripts/seed/search.py "tarde de lluvia"   # búsquedas de control
```

Todos los pasos cachean en `scripts/seed/data/` (ignorado en git): se reanudan
tras un corte y reejecutarlos no repite llamadas ni duplica filas.

---

## Esquema de base de datos

### `content` — películas y series del corpus

```sql
CREATE TABLE content (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tmdb_id       INTEGER NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('movie', 'tv')),
  title         TEXT NOT NULL,
  title_en      TEXT,
  year          INTEGER,
  director      TEXT,
  synopsis      TEXT,
  synopsis_en   TEXT,
  genres        TEXT[],
  keywords      TEXT[],
  autumn_score  FLOAT,
  embedding     VECTOR(1024),   -- Qwen3-Embedding-0.6B, dimensión nativa
  poster_path   TEXT,
  backdrop_path TEXT,
  runtime       INTEGER,
  seasons       INTEGER,
  status        TEXT CHECK (status IN ('released', 'ended', 'ongoing')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- TMDB numera películas y series en espacios independientes: /movie/550 y
  -- /tv/550 son obras distintas. La unicidad debe incluir el tipo.
  UNIQUE (tmdb_id, type)
);

-- HNSW y no ivfflat: no hay que dimensionar listas, da mejor recall y se puede
-- crear sobre la tabla vacía. Con 5.000 filas, ivfflat con lists=100 dejaría
-- ~50 filas por lista y degradaría la recuperación.
CREATE INDEX ON content USING hnsw (embedding vector_cosine_ops);
```

Qué contiene cada columna, tal como la rellena el seed:

- `title` y `synopsis` en español (es-ES, o si no otra variante del español);
  `title_en` y `synopsis_en` en inglés. Todo título tiene al menos una de las
  dos sinopsis
- `genres` en español, para mostrar. `keywords` en inglés: TMDB no las traduce
- `director`: en series, quien la crea (`created_by`), que es el equivalente
- `autumn_score` entre 0 y 1: la puntuación de deepseek-flash (0–100) / 100.
  Decide qué entra al corpus y sirve para reordenar candidatos en el chat
- `embedding`: de un texto en inglés (título, sinopsis, géneros y keywords),
  con la sinopsis española solo si falta la inglesa. Lo construye
  `document_text()` en `scripts/seed/common.py`

### `users_favorites`

```sql
CREATE TABLE users_favorites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  content_id  UUID REFERENCES content(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, content_id)
);
```

### `conversations`

```sql
CREATE TABLE conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  mode        TEXT NOT NULL CHECK (mode IN ('movie', 'tv', 'weekend', 'month')),
  messages    JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
```

### Función de búsqueda semántica

```sql
CREATE OR REPLACE FUNCTION search_content(
  query_embedding VECTOR(1024),
  content_type    TEXT DEFAULT NULL,
  match_count     INT DEFAULT 10,
  min_score       FLOAT DEFAULT 0.5
)
RETURNS TABLE (
  id UUID, tmdb_id INTEGER, type TEXT, title TEXT,
  year INTEGER, director TEXT, synopsis TEXT,
  genres TEXT[], autumn_score FLOAT, poster_path TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
```

La implementación está en `supabase/migrations/`, que es la fuente real. Lo que
no se ve en la firma:

- Es **PL/pgSQL y no SQL** solo para poder lanzar un error si el vector no tiene
  1024 dimensiones. Postgres **no** aplica los modificadores de tipo a los
  parámetros de función, así que el `VECTOR(1024)` de la firma no valida nada: un
  vector de otra dimensión entraría y la consulta devolvería 0 filas en silencio
- Descarta las filas con `embedding IS NULL`
- Limita `match_count` a 50: está expuesta por PostgREST a `anon`
- Lleva `SET hnsw.iterative_scan = strict_order`. Sin él, el índice HNSW devuelve
  como mucho 40 filas (`ef_search`) y el filtro por tipo se aplica después: con
  solo 500 series, las búsquedas de `tv` se quedaban en 2 o 3 candidatos. No
  quitarlo, y si se recrea la función, volver a ponerlo
- El `min_score` por defecto (0.5) es alto para este modelo: resultados buenos
  caen entre 0,45 y 0,6

---

## Flujo del chat

```
Usuario escribe
      ↓
POST /api/chat
      ↓
Embedding del mensaje (Qwen3-Embedding, servicio propio)
      ↓
Búsqueda semántica en pgvector → candidatos
      ↓
Enriquecer con datos TMDB (streaming, póster)
      ↓
Llamada a DeepSeek (`deepseek-flash`):
  - system.md (Umber)
  - user-context.md relleno con candidatos + modo + historial
  - Historial de mensajes de la conversación
      ↓
Stream de respuesta al cliente
      ↓
Guardar en Supabase (si autenticado)
```

---

## Los 4 modos

| Constante | Descripción | Estado |
|---|---|---|
| `movie` | Recomendación individual de película | MVP |
| `tv` | Recomendación individual de serie | MVP |
| `weekend` | Plan coherente para 2-3 días | v2 |
| `month` | Calendario completo del mes | v2 |

Los modos `weekend` y `month` están diseñados. No eliminar sus tipos ni constantes aunque no estén implementados.

---

## Convenciones de código

- TypeScript estricto — `strict: true` en tsconfig, sin `any`
- Variables de entorno siempre via `src/lib/env.ts`, nunca `process.env.X` suelto
- Errores siempre tipados, nunca `catch(e: any)`
- Comentarios en español, código (variables, funciones) en inglés
- `src/lib/database.types.ts` se **genera** con `npm run db:types`: no editarlo a
  mano. El generador no sabe expresar dos cosas del esquema —las columnas con
  `CHECK` salen como `string`, y `search_content` devuelve todo como no nulable—,
  así que esas correcciones viven en `src/lib/types.ts`
- Imports con alias `@/` para `src/`
- Streaming activado siempre en las llamadas al chat de DeepSeek

---

## DeepSeek — configuración

- Modelo chat: `deepseek-flash` (DeepSeek-V4.1-Flash) — mejor calidad/precio
- Base URL: `https://api.deepseek.com` (compatible con SDK de OpenAI)
- DeepSeek **no expone embeddings**: esa parte va contra el servicio de Qwen3
- Temperature chat: `0.8`
- Temperature clasificación/extracción: `0.1`
- Max tokens respuesta: `600`
- Usar streaming siempre para mejor UX. La excepción son los procesos por lotes
  (`scripts/seed/score.py`), donde nadie lee la respuesta mientras llega
- `deepseek-flash` **razona por defecto**, y los tokens del razonamiento cuentan
  contra `max_tokens`: con un tope bajo la respuesta llega vacía o cortada. Se
  desactiva con `thinking: { type: 'disabled' }` en el cuerpo de la petición
  (`extra_body` en el SDK de Python)
- **Sin razonamiento** en el chat de `movie` y `tv` y en `complete()`:
  `src/lib/deepseek.ts` lo envía siempre. `weekend` y `month` podrán activarlo,
  subiendo `max_tokens`. Motivo y medidas en `docs/fase-4-api-chat.md`

---

## Embeddings — configuración

- Modelo: `Qwen/Qwen3-Embedding-0.6B` (1024 dim nativas, 32k de contexto, 100+ idiomas)
- Se habla con él por la API de embeddings de OpenAI: TEI y vLLM la exponen igual,
  así que pasar de local a gestionado es cambiar `EMBEDDINGS_URL`
- Levantarlo en local con `npm run embeddings` (`scripts/embeddings/server.py`,
  sentence-transformers sobre MPS/CUDA/CPU). Con Docker, TEI es equivalente:
  ```bash
  docker run -p 8080:80 ghcr.io/huggingface/text-embeddings-inference:cpu-latest \
    --model-id Qwen/Qwen3-Embedding-0.6B
  ```
- El servidor carga el modelo en **float32** a propósito: transformers usa por
  defecto el bfloat16 del checkpoint, y eso mete ruido de ~1e-3 que hace que el
  mismo texto dé vectores distintos según el lote en el que vaya
- El modelo es **asimétrico**: la consulta va envuelta en
  `Instruct: {tarea}\nQuery:{texto}` y el documento en crudo. Omitir la
  instrucción cuesta entre un 1% y un 5% de precisión de recuperación
- Consultas vía `embedQuery()` en `src/lib/embeddings.ts`; el corpus, vía
  `scripts/seed/embed.py`. La normalización y la instrucción de tarea están
  duplicadas en `scripts/seed/common.py` y **tienen que coincidir** con las de
  TypeScript: si divergen, la búsqueda se degrada sin dar ningún error
- Cambiar de modelo o de dimensión obliga a reindexar el corpus completo

---

## TMDB — notas

- Usar `append_to_response=watch/providers` para obtener plataformas en una sola llamada
- Región por defecto para streaming: `ES`. Detectar por idioma del usuario si es posible
- Pósters: `https://image.tmdb.org/t/p/w500{poster_path}`
- Backdrops hero: `https://image.tmdb.org/t/p/original{backdrop_path}`
- Cachear respuestas de TMDB en Supabase para no repetir llamadas

---

## Estética

```
Fondo base:        #0D0B08  (negro cálido)
Superficie:        #1A1510  (capas de contenido)
Acento principal:  #C8872A  (ámbar)
Acento secundario: #7A4E2D  (siena)
Texto principal:   #E8DDD0  (crema cálida)
Texto secundario:  #8A7B6E  (gris cálido)

Tipografía display:  Playfair Display (serif)
Tipografía UI:       Inter (sans-serif)
```

---

## Seguridad

- RLS activado en todas las tablas de Supabase
- `SUPABASE_SECRET_KEY` solo en servidor y scripts de seed, nunca en cliente
- Validar todos los inputs antes de pasarlos al LLM
- El system prompt nunca se expone al cliente

---

## Lo que NO hacer

- No usar `localStorage` para historial de chat — va a Supabase
- No llamar a TMDB directamente desde el cliente — siempre vía `/api/tmdb`
- No hardcodear IDs de TMDB en el código
- No recomendar contenido sin pasar por el corpus vectorial — Umber no inventa títulos