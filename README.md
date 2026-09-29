# Umber 🍂

Planificador cinematográfico otoñal con IA. Conversas con Umber contándole cómo
te sientes y te devuelve la película o la serie que encaja con ese momento, no
con una etiqueta de género.

Por debajo: búsqueda por similitud semántica sobre un corpus de ~5.000 títulos
vectorizados en Supabase pgvector, con DeepSeek-V3 dando la voz.

La documentación técnica completa (esquema de base de datos, convenciones,
estética) está en [`.claude/CLAUDE.md`](.claude/CLAUDE.md).

## Requisitos

- Node.js ≥ 22.12
- Cuentas en [DeepSeek](https://platform.deepseek.com),
  [Supabase](https://supabase.com) y [TMDB](https://www.themoviedb.org/settings/api)

## Puesta en marcha

```bash
npm install
cp .env.example .env.local   # y rellena las credenciales
npm run dev                  # http://localhost:4321
```

### Servicio de embeddings

DeepSeek no expone endpoint de embeddings, así que la vectorización va contra un
Qwen3-Embedding-0.6B propio (1024 dimensiones). En local, con Docker:

```bash
docker run -p 8080:80 ghcr.io/huggingface/text-embeddings-inference:cpu-latest \
  --model-id Qwen/Qwen3-Embedding-0.6B
```

Expone la API de embeddings de OpenAI, así que sustituirlo por un endpoint
gestionado es cambiar `EMBEDDINGS_URL`. En producción tiene que ser un servicio
alcanzable desde la función de Vercel: el modelo no cabe en una serverless.

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo |
| `npm run build` | Build de producción (salida para Vercel) |
| `npm run preview` | Preview del build |
| `npm run typecheck` | `astro check` — TypeScript y plantillas Astro |
| `npm run sync` | Regenera los tipos de `astro:env` y content collections |

## Estado

El seguimiento por fases está en [`docs/`](docs/README.md): lo hecho, lo
pendiente, las decisiones tomadas con su motivo y las preguntas abiertas.

| Fase | Contenido | Estado |
|---|---|---|
| [1](docs/fase-1-scaffolding.md) | Andamiaje y configuración base | ✅ |
| [2](docs/fase-2-base-de-datos.md) | Esquema de Supabase, pgvector y RLS | ⏳ |
| [3](docs/fase-3-seed-corpus.md) | Seed del corpus desde TMDB | ⏳ |
| [4](docs/fase-4-api-chat.md) | API del chat con streaming | ⏳ |
| [5](docs/fase-5-frontend.md) | Frontend, ficha de contenido y auth | ⏳ |
| [6](docs/fase-6-pulido-despliegue.md) | Pulido, i18n y despliegue | ⏳ |
