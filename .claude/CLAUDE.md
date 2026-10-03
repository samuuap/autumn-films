# CLAUDE.md — Proyecto Umber 🍂

Planificador cinematográfico otoñal con IA. Chat conversacional que recomienda películas y series según el estado de ánimo del usuario, usando DeepSeek + búsqueda semántica sobre un corpus de ~5.000 títulos vectorizados en Supabase pgvector.

---

## Stack

| Capa | Tecnología |
|---|---|
| Frontend | Astro + Tailwind CSS |
| LLM | DeepSeek-V4.1-Flash (`deepseek-flash`) |
| Embeddings | Qwen3-Embedding-0.6B (1024 dim, API de OpenAI): Cloudflare Workers AI; en local, `npm run embeddings` |
| Base de datos | Supabase (PostgreSQL + pgvector) |
| Auth | Supabase Auth |
| Datos de cine | TMDB API v3 |
| Deploy | Vercel |

---

## Estructura del proyecto

```
/
├── src/
│   ├── components/          # SiteHeader, SiteFooter, ModeCard, ContentCard, ChatMessage, AuthForm
│   ├── layouts/
│   │   └── Layout.astro     # Layout base: tema, tipografías, metadatos, cabecera y pie
│   ├── middleware.ts        # Sesión de Supabase (cookies) en Astro.locals, en cada petición
│   ├── env.d.ts             # Tipos de Astro.locals
│   ├── pages/
│   │   ├── index.astro      # Pantalla de inicio — selector de modo
│   │   ├── chat.astro       # Chat: ?mode=movie para empezar, ?conversation=<id> para retomar
│   │   ├── entrar.astro     # Login (formulario sin JS)
│   │   ├── registro.astro   # Registro: usuario, email y contraseña dos veces; exige confirmar el email
│   │   ├── salir.ts         # POST: cierra la sesión de este navegador
│   │   ├── favoritos.astro  # Favoritos, con plataformas pedidas a TMDB en servidor
│   │   ├── conversaciones.astro  # Conversaciones guardadas; POST para borrar una
│   │   ├── explorar/
│   │   │   ├── index.astro  # El corpus en carteles: búsqueda, tipo, género, orden, páginas
│   │   │   └── [id].astro   # Ficha de un título: sinopsis, plataformas, favorito
│   │   ├── auth/
│   │   │   └── confirm.ts   # Vuelta del enlace del email (code o token_hash)
│   │   └── api/
│   │       ├── chat.ts      # Endpoint principal — orquesta búsqueda, DeepSeek y SSE
│   │       ├── favorites.ts # POST / DELETE de favoritos
│   │       ├── search.ts    # POST: la búsqueda del chat sin el modelo (depurar, buscador)
│   │       └── tmdb.ts      # GET: plataformas de un título del corpus, con caché
│   ├── lib/
│   │   ├── env.ts           # Único acceso a variables de entorno (servidor)
│   │   ├── env.client.ts    # Variables públicas para el navegador
│   │   ├── errors.ts        # Jerarquía de errores tipados
│   │   ├── types.ts         # Tipos de dominio, los 4 modos y el contrato de /api/chat
│   │   ├── database.types.ts  # Tipos de las tablas de Supabase
│   │   ├── deepseek.ts      # Cliente DeepSeek (compatible con SDK OpenAI)
│   │   ├── supabase.ts      # Clientes Supabase (anon / cookies / usuario / service)
│   │   ├── tmdb.ts          # Funciones TMDB
│   │   ├── platforms.ts     # Plataformas de TMDB con caché en Supabase (platforms_cache)
│   │   ├── rate-limit.ts    # Límites de /api/chat y /api/search por usuario o IP
│   │   ├── recommendations.ts # Fichas por id, para las conversaciones retomadas
│   │   ├── explore.ts       # Filtros de /explorar en la URL, listado, géneros y ficha
│   │   ├── embeddings.ts    # Generación de embeddings (Qwen3 autoalojado)
│   │   ├── search.ts        # Búsqueda semántica: suelo de similitud y reordenado
│   │   ├── chat.ts          # Validación del chat, contexto del modelo y fichas
│   │   ├── turns.ts         # Estado de la conversación: preguntas, búsqueda, candidatos que quedan
│   │   ├── prompts.ts       # Carga y rellena las plantillas de src/prompts/
│   │   ├── auth.ts          # Usuario de la sesión o del token, redirecciones y errores
│   │   ├── conversations.ts # Leer, listar y guardar conversaciones con RLS
│   │   ├── favorites.ts     # Favoritos con RLS
│   │   ├── api.ts           # JSON y errores comunes de los endpoints
│   │   ├── locale.ts        # Idioma y región desde Accept-Language
│   │   ├── markdown.ts      # Texto de Umber a HTML, escapado (servidor y navegador)
│   │   └── chat-stream.ts   # Lector del SSE de /api/chat en el navegador
│   ├── scripts/             # JavaScript del navegador (sin framework)
│   │   ├── chat.ts          # El chat: envío, stream, errores, fichas
│   │   ├── content-card.ts  # Rellenar fichas y botón de favorito
│   │   ├── explore.ts       # Aplicar al momento el género y el orden de /explorar
│   │   ├── auth-form.ts     # Mostrar la contraseña y avisar si las dos no coinciden
│   │   └── conversations.ts # Confirmar antes de borrar una conversación
│   ├── prompts/
│   │   ├── system.md        # System prompt de Umber (identidad, tono, reglas)
│   │   └── user-context.md  # Plantilla del user prompt con {{variables}}
│   └── styles/
│       └── global.css       # Tailwind + tema otoñal
├── scripts/
│   ├── verify-schema.mjs    # Comprueba esquema y RLS vía Data API
│   ├── embeddings/
│   │   └── server.py        # Qwen3-Embedding local con la API de OpenAI (sin conexión)
│   └── seed/
│       ├── common.py        # Entorno, HTTP, JSONL y el texto canónico de cada título
│       ├── fetch-tmdb.py    # Descarga el universo de candidatos de TMDB
│       ├── score.py         # autumn_score (3 pasadas de deepseek-flash, media) y selección
│       ├── embed.py         # Vectoriza el corpus con Qwen3
│       ├── load-db.py       # Upsert del corpus en Supabase pgvector
│       ├── search.py        # Búsquedas de control contra el corpus cargado
│       └── check-embeddings.py  # ¿Da un servicio los mismos vectores que el corpus?
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

EMBEDDINGS_URL=            # Cloudflare Workers AI: https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1
EMBEDDINGS_API_KEY=        # Token de Cloudflare (Workers AI Read y Edit)
EMBEDDINGS_MODEL=          # @cf/qwen/qwen3-embedding-0.6b (el servidor local: Qwen/Qwen3-Embedding-0.6B)

SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=      # Scripts de seed y servidor. /api/chat no funciona sin ella (rate limiting)

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
python scripts/seed/check-embeddings.py            # ¿da el servicio de .env.local los vectores del corpus?
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
- `autumn_score` entre 0 y 1: la media de 3 puntuaciones de deepseek-flash
  (0–100), en lotes distintos, / 100. Decide qué entra al corpus y sirve para
  reordenar candidatos en el chat. El criterio es **otoño antes que Halloween**:
  Halloween cuenta si la película va de él, y el terror sin Halloween ni ambiente
  otoñal puntúa 40 como mucho. El prompt está en `scripts/seed/score.py`
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

### `profiles`

```sql
CREATE TABLE profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username    TEXT UNIQUE CHECK (username ~ '^[a-z0-9_]{3,20}$'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- true si nadie tiene ese nombre. Para anon: explica por qué falló un registro
is_username_available(p_username TEXT) RETURNS BOOLEAN
```

- `username` es **copia** de `raw_user_meta_data->>'username'` de `auth.users`:
  la escriben dos triggers (`sync_profile_from_auth_user`), al crearse el usuario
  y cada vez que cambia ese dato. Por eso la app lo lee de la sesión
  (`user_metadata` de los claims) sin consultar la tabla. Nunca escribirlo en
  `profiles` desde la app: no hay políticas de escritura
- Si el nombre está cogido o no cumple el formato, falla la operación de Auth
  entera (registro o `updateUser`) con un error genérico de base de datos. Se
  manda ya normalizado, en minúsculas (`normalizeUsername()` en `src/lib/auth.ts`)
- Sin `username` en los metadatos (Admin API, cuentas anteriores, Google cuando
  llegue) queda en `null`

### `conversations`

```sql
CREATE TABLE conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  mode        TEXT NOT NULL CHECK (mode IN ('movie', 'tv', 'weekend', 'month')),
  messages    JSONB NOT NULL DEFAULT '[]',  -- { role, content, created_at } y, en los de
                                           -- Umber, recommendation_ids y language
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Añade al final en un solo UPDATE, con RLS de quien llama. false si no existe
-- o es de otro usuario. Nunca leer, concatenar y reescribir `messages` desde la
-- app: con dos peticiones a la vez se pierde un turno
append_conversation_messages(p_id UUID, p_messages JSONB) RETURNS BOOLEAN
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
  id UUID, tmdb_id INTEGER, type TEXT, title TEXT, title_en TEXT,
  year INTEGER, director TEXT, synopsis TEXT, synopsis_en TEXT,
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
- Devuelve los dos títulos y las dos sinopsis: el chat da los candidatos en el
  idioma de la respuesta. Cambiar las columnas de `RETURNS TABLE` obliga a
  borrarla y crearla entera (ver `20260930180000`), con todo lo de esta lista
- Limita `match_count` a 50: está expuesta por PostgREST a `anon`
- Lleva `SET hnsw.iterative_scan = strict_order`. Sin él, el índice HNSW devuelve
  como mucho 40 filas (`ef_search`) y el filtro por tipo se aplica después: con
  solo 500 series, las búsquedas de `tv` se quedaban en 2 o 3 candidatos. No
  quitarlo, y si se recrea la función, volver a ponerlo
- El `min_score` por defecto (0.5) es alto para este modelo: en películas, lo
  bueno cae entre 0,40 y 0,55, y en series, que son 500, puede quedarse en 0,32
- **No pasarle un `min_score` que pocas filas superen.** La búsqueda iterativa
  sigue recorriendo el índice hasta completar el `LIMIT`: con 0.99, hasta 4,3 s y
  un timeout del rol `anon`. El chat pide con `min_score = -1` y aplica su suelo
  (0,30) en `src/lib/search.ts`; como las filas llegan ordenadas, da lo mismo

### Explorar el corpus

```sql
-- Una página del listado; en cada fila, el total con esos filtros
explore_content(p_type TEXT, p_genre TEXT, p_query TEXT,
                p_sort TEXT DEFAULT 'autumn',  -- 'autumn' | 'recent' | 'title'
                p_limit INT DEFAULT 36, p_offset INT DEFAULT 0)
  RETURNS TABLE (id, type, title, title_en, year, poster_path, autumn_score, total_count)

content_genres(p_type TEXT DEFAULT NULL) RETURNS TABLE (genre TEXT, titles BIGINT)
```

- `p_query` busca en el título (los dos idiomas) y en el director, **sin tildes
  ni mayúsculas**: «otono» encuentra «Otoño». Lo hace `fold_search_text()` con
  `translate`, no con la extensión unaccent. `%` y `_` del usuario son texto
- Expuestas a `anon` (el corpus es público) y con `p_limit` de 60 como mucho
- Se usan desde `src/lib/explore.ts`; sus filas pasan por `ExploreItem` en
  `src/lib/types.ts`, por la misma razón que `search_content`

### `platforms_cache` y `rate_limits` — solo servidor

```sql
CREATE TABLE platforms_cache (
  content_id  UUID PRIMARY KEY REFERENCES content(id) ON DELETE CASCADE,
  by_region   JSONB NOT NULL,        -- {"ES": ["Netflix", "Filmin"], …}
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE rate_limits (
  key            TEXT NOT NULL,      -- '<ámbito>:user:<uuid>' o '<ámbito>:ip:<dirección>' (IPv6: su /64)
  window_seconds INTEGER NOT NULL,
  window_start   TIMESTAMPTZ NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  hits           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_seconds, window_start)
);

-- 0 si la petición cabe; si no, segundos hasta poder repetir
hit_rate_limit(p_key TEXT, p_window_seconds INT[], p_limits INT[]) RETURNS INTEGER
```

- Las dos tablas tienen RLS **sin políticas** y sin permisos para `anon` ni
  `authenticated`; `hit_rate_limit` solo la ejecuta `service_role`. Se usan con
  `getSupabaseAdminClient()`: no son datos de ningún usuario, y abrir la función
  a la publishable key dejaría gastar el cupo de otra IP
- `by_region` lleva **todas las regiones**, ya normalizadas por
  `getStreamingNamesByRegion()`: TMDB las manda juntas. Una región que no aparece no
  tiene plataformas de suscripción ni gratis. La caducidad (3 días) la aplica
  `src/lib/platforms.ts`; una fila caducada no se borra, porque sirve de
  respaldo si TMDB no responde
- `hit_rate_limit` cuenta en ventanas fijas alineadas con la época (el día es de
  UTC) y borra lo caducado en cada llamada. Los límites viven en
  `src/lib/rate-limit.ts`

---

## Flujo del chat

Umber conversa: pregunta de 2 a 4 veces para entender el ánimo, decide él cuándo
buscar y busca con un resumen que escribe él. Si piden otra, la saca de los
mismos 10 candidatos hasta agotarlos. Reglas y estado en `src/lib/turns.ts`.

```
Usuario escribe
      ↓
POST /api/chat → validar (parseChatRequest)
      ↓
A la vez:
  - Rate limit (hit_rate_limit): 8/min; 300/día con sesión, 60/día por IP sin ella → 429
  - Historial: de Supabase si hay conversation_id, si no el que manda el cliente
      ↓
Estado (conversationState): preguntas seguidas, última búsqueda, candidatos que
quedan. Idioma de la respuesta (detectMessageLanguage)
      ↓
Candidatos que quedan de la última búsqueda: de la base por id, con plataformas
      ↓
DeepSeek (`deepseek-flash`) con la herramienta buscar_titulos. tool_choice:
none hasta haber preguntado 2 veces · required con 4 preguntas seguidas · auto el resto
  ├─ texto: una pregunta, u «otra» de los que quedan → al cliente
  └─ buscar_titulos(resumen en inglés):
        Evento `searching` al cliente («Buscando títulos que encajen…»)
              ↓
        Embedding del resumen (Qwen3-Embedding, Cloudflare Workers AI)
              ↓
        pgvector → 30 candidatos, sin los ya recomendados
              ↓
        Reordenar por similitud + 0,2 × autumn_score → 10
              ↓
        Plataformas (platforms_cache, 3 días; si no, TMDB con 2 s de tope)
              ↓
        Segunda llamada a DeepSeek con los candidatos → la recomendación
      ↓
Stream SSE al cliente (los primeros 280 caracteres se retienen: un preámbulo
antes de buscar se descarta)
      ↓
Guardar en Supabase (si autenticado; append_conversation_messages) con search y
recommendation_ids → evento `done`
```

La búsqueda ocurre con el stream ya abierto, detrás del evento `searching`: la
espera más larga del chat (unos 4 s, sobre todo el embedding de Cloudflare)
tiene un aviso en pantalla. Por eso un fallo del buscador llega como evento
`error`, no con su código HTTP.

Contrato de `POST /api/chat`, tipado en `src/lib/types.ts`:

- **Cuerpo** (`ChatRequestBody`): `mode`, `message` (≤ 1.000 caracteres) y,
  opcionales, `history` (≤ 40 mensajes `user`/`assistant`, solo sin
  conversación guardada), `conversation_id`, `locale` y `region`. Los mensajes
  de Umber del historial llevan lo que devolvió `done`: `search` y
  `recommendation_ids`. Sin eso, el servidor no sabe qué candidatos le quedan
- **Sesión**: la de las cookies (el navegador) o `Authorization: Bearer
  <access_token>` (scripts). Sin ninguna se chatea sin guardar; con un token
  inválido o caducado, 401
- **Respuesta** (`ChatStreamEvent`): `text/event-stream` con `delta { text }`
  por fragmento, `searching {}` justo antes de buscar y, al final, `done {
  conversation_id, recommendations, search }` o `error { code, message }`. `recommendations` trae la ficha de cada título que
  Umber ha nombrado (vacío si ha preguntado): id del corpus, póster y
  plataformas. `search` es la búsqueda del turno (resumen y candidatos), o `null`
- **Errores antes de abrir el stream** (validar, sesión, rate limit, historial,
  abrir DeepSeek): JSON `{ error: { code, message } }` con el `status` del error
  tipado (400, 401, 404, 429, 502). `message` se puede mostrar tal cual. El 429
  (`rate_limited`) lleva `Retry-After` en segundos. Lo que falla después,
  búsqueda incluida, llega como evento `error` con el mismo `code` y `message`

Los otros dos endpoints, con el mismo formato de error:

- **`POST /api/search`** (`SearchRequestBody` → `SearchResponse`): `{ query,
  type?, limit? }`, con `limit` de 1 a 30. Devuelve lo mismo que ve Umber, con
  `similarity`, `autumn_score` y `rank_score`. Sesión opcional; rate limit
  propio (20/min y 300/día por IP, 30/min y 1.000/día con sesión)
- **`GET /api/tmdb?content_id=<uuid>&region=ES`** (`PlatformsResponse`):
  plataformas de un título del corpus, por `lookupPlatforms`. Sin `region`, la de
  `Accept-Language`. `Cache-Control` público de un día en la CDN. No acepta rutas
  de TMDB: no es un proxy libre

---

## Auth

- Sesión por **SSR en cookies** con `@supabase/ssr`. No hay cliente de Supabase
  en el navegador, así que las cookies van `httpOnly` y las claves siguen sin
  prefijo `PUBLIC_`
- `src/middleware.ts` crea en cada petición el cliente con las cookies y verifica
  la sesión con `getClaims()`: en local, con las claves ES256 del proyecto, sin
  llamada de red. Deja `Astro.locals.supabase` y `Astro.locals.user`
- Leer y escribir datos del usuario siempre con `Astro.locals.supabase` (o
  `getRequestUser()` en endpoints), nunca con la secret key: RLS hace el resto.
  Las únicas tablas que la app toca con la secret key son `platforms_cache` y
  `rate_limits`, que no son de ningún usuario
- El proyecto **exige confirmar el email**. El enlace vuelve a `/auth/confirm`,
  que tiene que estar en *Redirect URLs* del dashboard (Authentication → URL
  Configuration), junto con la *Site URL*. Con la plantilla de email por
  defecto (`?code=`) el enlace solo funciona en el navegador del registro; la
  plantilla con `?token_hash=` funciona en cualquiera
- Registrar emails inventados hace rebotar el SMTP por defecto de Supabase, que
  limita los envíos. Para probar, crear usuarios ya confirmados con la Admin API
  (como hace `scripts/verify-rls.mjs`) y, si hace falta un enlace, sacarlo de
  `/auth/v1/admin/generate_link`, que no envía correo
- El registro pide **nombre de usuario**, email y la contraseña dos veces (8 a 72
  caracteres, el tope de bcrypt). El nombre va en `signUp({ options: { data: {
  username } } })` y acaba en `profiles` (ver el esquema). Se entra con el email
- `AuthForm` funciona sin JavaScript; con él, añade «Mostrar» en cada contraseña
  y el aviso de que no coinciden. Los errores de un campo salen junto a él
  (`AuthFormError`)
- **Pendiente: entrar con Google.** Ver `docs/fase-5-frontend.md`

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
- JavaScript del navegador en `src/scripts/`, sin framework. Solo puede importar
  de `src/lib/` los módulos que no tocan servidor: `types.ts`, `markdown.ts`,
  `chat-stream.ts`
- Astro pinta el `<script>` de un componente donde se pinta el componente. Si el
  componente va dentro de un `<template>` (como `ContentCard` en el chat), su
  script queda inerte: quien clona la plantilla tiene que inicializarlo
- Texto que viene del LLM o del usuario: `textContent`, o `renderReply()`, que
  escapa antes de dar formato. Nunca `innerHTML` con texto sin escapar

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
- **Servicio: Cloudflare Workers AI** (`@cf/qwen/qwen3-embedding-0.6b`), gratis
  hasta 10.000 neuronas al día (~90.000 consultas); al pasarse falla, no cobra.
  Da los mismos vectores que el servidor local que indexó el corpus. Se configura
  con `EMBEDDINGS_URL` (`https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1`),
  `EMBEDDINGS_API_KEY` (token con Workers AI Read y Edit) y `EMBEDDINGS_MODEL`
- **Antes de apuntar `EMBEDDINGS_URL` a cualquier servicio nuevo**, pasar
  `scripts/seed/check-embeddings.py`: vectores distintos degradan la búsqueda sin
  dar ningún error. El `text_hash` del corpus usa el modelo, no el servicio:
  cambiar de servicio no obliga a revectorizar
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
- Las plataformas se piden siempre con `lookupPlatforms()` (`src/lib/platforms.ts`),
  que las cachea en `platforms_cache`, y no con las funciones de `src/lib/tmdb.ts`

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
- **CSP** con `security.csp` de Astro (`astro.config.mjs`): hashes de los
  scripts y estilos propios, imágenes solo de `image.tmdb.org`, sin iframes
  (`frame-ancestors 'none'`). En SSR va como cabecera: **no poner otra cabecera
  `Content-Security-Policy` en el middleware**, que la sustituiría. Un recurso
  externo nuevo (imágenes, fuentes, `fetch` del navegador) hay que añadirlo a
  sus directivas. No funciona en `astro dev`: se prueba sobre el build
- `src/middleware.ts` añade `X-Content-Type-Options`, `X-Frame-Options` y
  `Referrer-Policy` a todas las respuestas

---

## Lo que NO hacer

- No usar `localStorage` para historial de chat — va a Supabase
- No llamar a TMDB directamente desde el cliente — siempre vía `/api/tmdb`
- No hardcodear IDs de TMDB en el código
- No recomendar contenido sin pasar por el corpus vectorial — Umber no inventa títulos