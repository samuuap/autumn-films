# Estado del proyecto — Umber 🍂

Índice de fases. Cada archivo lleva lo hecho, lo pendiente, las decisiones
tomadas con su motivo y las preguntas abiertas de esa fase.

La documentación **técnica** (stack, esquema, convenciones, estética) está en
[`.claude/CLAUDE.md`](../.claude/CLAUDE.md). Aquí solo vive el estado del trabajo.

| Fase | Contenido | Estado |
|---|---|---|
| [1](fase-1-scaffolding.md) | Scaffolding y configuración base | ✅ Completada |
| [2](fase-2-base-de-datos.md) | Base de datos: esquema, pgvector y RLS | ✅ Completada |
| [3](fase-3-seed-corpus.md) | Seed del corpus desde TMDB | ✅ Completada |
| [4](fase-4-api-chat.md) | API del chat con streaming | ✅ Completada |
| [5](fase-5-frontend.md) | Frontend, ficha de contenido y auth | ✅ Completada |
| [6](fase-6-pulido-despliegue.md) | Pulido, i18n y despliegue | ⏳ Pendiente |

Leyenda: ✅ completada · 🔄 en curso · ⏳ pendiente · ⛔ bloqueada

---

## Decisiones transversales

Decisiones que afectan a más de una fase. Las específicas están en el archivo de
su fase.

| Decisión | Motivo | Afecta a |
|---|---|---|
| Embeddings con `Qwen/Qwen3-Embedding-0.6B` autoalojado, 1024 dim | DeepSeek no expone endpoint de embeddings ni existe el modelo `deepseek-embedding` que asumía el diseño inicial. Se elige local para no depender de un tercero ni pagar por token | 2, 3, 4, 6 |
| Chat con `deepseek-flash` (DeepSeek-V4.1-Flash) | Mejor calidad/precio de su catálogo. Los candidatos llegan ya filtrados por la búsqueda vectorial, así que el modelo solo elige uno y redacta 600 tokens | 4 |
| Hablar con el servicio de embeddings por la API de OpenAI | TEI y vLLM la exponen igual, así que pasar de local a gestionado es cambiar `EMBEDDINGS_URL` y nada más | 3, 4, 6 |
| Consultas y documentos vectorizados de forma asimétrica | Qwen3-Embedding pierde entre 1% y 5% de precisión de recuperación si la consulta no va envuelta en `Instruct: {tarea}\nQuery:{texto}` | 3, 4 |
| Instrucción de la consulta centrada en el ánimo, sin «autumnal» | Todo el corpus ya es otoñal: la palabra no filtraba nada y traía títulos con «otoño» en el nombre (14 de 120 resultados; ahora 0). Vive en `embeddings.ts` y `common.py`, que tienen que coincidir | 3, 4 |
| Variables de entorno con `astro:env` en vez de `import.meta.env` | Valida en build que no falte ninguna y hace imposible que un secreto de servidor entre en el bundle de cliente | 1, 4, 5 |
| Esquema versionado en `supabase/migrations/` con el CLI de Supabase | El esquema queda en el repo, revisable en diff y reproducible tras cada reindexado del corpus | 2, 3 |
| Índice vectorial HNSW en lugar de ivfflat | Sin listas que dimensionar, mejor recall, y se crea sobre la tabla vacía. A 5.000 filas el `lists = 100` del diseño original degradaría la recuperación | 2, 4 |
| `search_content` con `hnsw.iterative_scan = strict_order` | Sin ella, el índice devolvía como mucho 40 filas y el filtro por tipo actuaba después: con el plan genérico, 295 de 300 búsquedas de series se quedaban cortas, alguna con 0. Medido y corregido en la Fase 3 | 2, 3, 4 |
| `autumn_score` = media de 3 pasadas de deepseek-flash (0–100) / 100 sobre todo el universo, sin prefiltro | Una pasada cambiaba hasta 40 puntos según el lote, y el prefiltro heurístico premiaba el terror y dejaba fuera clásicos como *Tienes un e-mail*. Unos 0,40 USD por pasada. Se cachea con un hash del prompt, así que el corpus es reproducible | 3, 4 |
| **Otoño antes que Halloween** en el criterio de `autumn_score` | Decisión de producto: lo que es sí o sí de otoño (*El club de los poetas muertos*, *Las chicas Gilmore*, *Harry Potter*). Halloween cuenta si la película va de él; el terror sin Halloween ni otoño, 40 como mucho. El terror pasó del 30 % al 14 % del corpus | 3, 4 |
| `autumn_score` filtra el corpus **y** reordena en el chat, con peso 0,2 | Umber solo conoce títulos otoñales, y dentro de ellos los más otoñales pesan más. Era 0,1 mientras el score tenía el ruido de una sola pasada | 3, 4 |
| Corpus 90/10: 4.500 películas y 500 series | Decisión de producto. TMDB tiene muchas menos series con votos suficientes | 3, 4, 5 |
| Documentos vectorizados en inglés, con respaldo en español | TMDB solo tiene keywords en inglés y sus sinopsis inglesas son más completas. La recuperación con consultas en español funciona | 3, 4, 6 |
| Embeddings locales con un servidor Python propio (`npm run embeddings`) | No hay Docker, y Docker Desktop exige licencia de pago en una empresa grande. Habla la misma API que TEI, así que el código TypeScript no cambia | 3, 4, 6 |
| deepseek-flash sin razonamiento: en la puntuación del corpus y en el chat de `movie` y `tv` | Razona por defecto y esos tokens cuentan contra `max_tokens`: vaciaba respuestas de la puntuación y, en el chat, 2 de 6 respuestas medidas; con más tope, la primera palabra tardaba hasta 6,3 s sin elegir mejor. `weekend` y `month` podrán activarlo | 3, 4 |
| El umbral de similitud se aplica en TypeScript; `search_content` recibe `min_score = -1` | Con un umbral que pocas filas superan, la búsqueda iterativa recorre todo el índice para completar el `LIMIT`: medido hasta 4,3 s y un timeout del rol `anon`. Filtrar después da el mismo resultado | 2, 4 |
| Sesión por SSR en cookies `httpOnly` (`@supabase/ssr`), verificada en el middleware | Las claves de Supabase siguen solo en servidor, RLS se evalúa en servidor y un XSS no puede leer la sesión. Los endpoints aceptan también `Authorization: Bearer` para scripts | 4, 5 |
| Producción sin gastos fijos; embeddings en Cloudflare Workers AI (plan gratuito) | Decisión de producto: solo se paga DeepSeek. Cloudflare sirve el mismo Qwen3-Embedding-0.6B con vectores idénticos a los del corpus, sin servidor que mantener. Hugging Face exige PRO desde julio de 2026. Se acepta su latencia: 1,2 s de mediana por consulta, con picos de varios segundos | 6 |
| Interfaz sin framework: Astro y `<script>` | Una pantalla con poco estado; el proyecto sigue sin dependencias de framework | 5 |
| Plataformas de TMDB cacheadas en una tabla aparte (`platforms_cache`), 3 días, todas las regiones | TMDB manda todas las regiones en la misma respuesta. Tabla aparte para que la app no escriba en el corpus. La usan el chat y los favoritos | 4, 5 |
| **Conversación guiada**: Umber pregunta de 2 a 4 veces, busca cuando lo decide con un resumen del ánimo, y «otra» sale de los mismos 10 candidatos | Decisión de producto: un cinéfilo que te conoce, no un buscador. Las reglas las hace cumplir el servidor con `tool_choice`, y el estado viaja en los propios mensajes | 4, 5 |
| El idioma de la respuesta lo decide el servidor, y los candidatos llegan en ese idioma | Dejarlo al modelo acertó 11 de 20 mensajes (9 de 10 en inglés recibieron la respuesta en español); con el detector, 20 de 20. Con título y sinopsis en inglés, además, nombra *Always Be My Maybe* y no *Siempre queda el amor* | 4, 6 |
| Rate limiting de `/api/chat` en Supabase (`rate_limits` + `hit_rate_limit`), por usuario o por IP | En Vercel un contador en memoria no sirve, y Supabase ya está: sin otro proveedor. Si el contador falla, el chat también, para no quedar abierto sin saberlo | 4, 6 |

---

## Preguntas abiertas

Ordenadas por la fase que las bloquea. El detalle está en cada archivo.

| # | Pregunta | Bloquea |
|---|---|---|
| 1 | ¿Debe `anon` poder leer la columna `embedding`? | [Fase 2](fase-2-base-de-datos.md) |

---

## Cómo mantener esto

- Al cerrar una fase, mover sus casillas de **Pendiente** a **Hecho** y cambiar
  el estado en la tabla de arriba
- Cuando se resuelve una pregunta abierta, no se borra: pasa a la tabla de
  decisiones de su fase con el motivo. El motivo es lo que evita volver a
  discutirlo dentro de tres meses
- Las decisiones que cambien el esquema o el stack van también a `CLAUDE.md`,
  que es la fuente de verdad técnica
