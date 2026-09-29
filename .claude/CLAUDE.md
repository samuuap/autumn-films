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
│   └── seed/
│       ├── fetch-tmdb.py    # Descarga películas/series de TMDB
│       ├── embed.py         # Vectoriza sinopsis + keywords con Qwen3
│       └── load-db.py       # Carga vectores en Supabase pgvector
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

# Seed del corpus (una vez, o para actualizaciones)
cd scripts/seed
pip install -r requirements.txt
python fetch-tmdb.py   # ~5000 títulos de TMDB
python embed.py        # Genera embeddings
python load-db.py      # Carga en Supabase
```

---

## Esquema de base de datos

### `content` — películas y series del corpus

```sql
CREATE TABLE content (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tmdb_id       INTEGER UNIQUE NOT NULL,
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
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON content USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```

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
LANGUAGE sql STABLE AS $$
  SELECT id, tmdb_id, type, title, year, director, synopsis,
         genres, autumn_score, poster_path,
         1 - (embedding <=> query_embedding) AS similarity
  FROM content
  WHERE (content_type IS NULL OR type = content_type)
    AND 1 - (embedding <=> query_embedding) > min_score
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
```

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
- Usar streaming siempre para mejor UX

---

## Embeddings — configuración

- Modelo: `Qwen/Qwen3-Embedding-0.6B` (1024 dim nativas, 32k de contexto, 100+ idiomas)
- Se habla con él por la API de embeddings de OpenAI: TEI y vLLM la exponen igual,
  así que pasar de local a gestionado es cambiar `EMBEDDINGS_URL`
- Levantarlo en local:
  ```bash
  docker run -p 8080:80 ghcr.io/huggingface/text-embeddings-inference:cpu-latest \
    --model-id Qwen/Qwen3-Embedding-0.6B
  ```
- El modelo es **asimétrico**: la consulta va envuelta en
  `Instruct: {tarea}\nQuery:{texto}` y el documento en crudo. Omitir la
  instrucción cuesta entre un 1% y un 5% de precisión de recuperación
- Vectorizar siempre vía `src/lib/embeddings.ts`: `embedQuery()` para el mensaje
  del usuario, `embedDocuments()` para el corpus
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