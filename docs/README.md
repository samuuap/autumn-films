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
| [4](fase-4-api-chat.md) | API del chat con streaming | 🔄 En curso |
| [5](fase-5-frontend.md) | Frontend, ficha de contenido y auth | ⏳ Pendiente |
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
| Variables de entorno con `astro:env` en vez de `import.meta.env` | Valida en build que no falte ninguna y hace imposible que un secreto de servidor entre en el bundle de cliente | 1, 4, 5 |
| Esquema versionado en `supabase/migrations/` con el CLI de Supabase | El esquema queda en el repo, revisable en diff y reproducible tras cada reindexado del corpus | 2, 3 |
| Índice vectorial HNSW en lugar de ivfflat | Sin listas que dimensionar, mejor recall, y se crea sobre la tabla vacía. A 5.000 filas el `lists = 100` del diseño original degradaría la recuperación | 2, 4 |
| `search_content` con `hnsw.iterative_scan = strict_order` | Sin ella, el índice devolvía como mucho 40 filas y el filtro por tipo actuaba después: con el plan genérico, 295 de 300 búsquedas de series se quedaban cortas, alguna con 0. Medido y corregido en la Fase 3 | 2, 3, 4 |
| `autumn_score` = puntuación 0–100 de deepseek-flash / 100, con prefiltro heurístico | La heurística sola es tosca y el LLM solo gasta llamadas en blockbusters obvios. Se cachea con un hash del prompt, así que el corpus es reproducible | 3, 4 |
| `autumn_score` filtra el corpus **y** reordena en el chat | Umber solo conoce títulos otoñales, y dentro de ellos los más otoñales pesan más | 3, 4 |
| Corpus 90/10: 4.500 películas y 500 series | Decisión de producto. TMDB tiene muchas menos series con votos suficientes | 3, 4, 5 |
| Documentos vectorizados en inglés, con respaldo en español | TMDB solo tiene keywords en inglés y sus sinopsis inglesas son más completas. La recuperación con consultas en español funciona | 3, 4, 6 |
| Embeddings locales con un servidor Python propio (`npm run embeddings`) | No hay Docker, y Docker Desktop exige licencia de pago en una empresa grande. Habla la misma API que TEI, así que el código TypeScript no cambia | 3, 4, 6 |
| deepseek-flash sin razonamiento: en la puntuación del corpus y en el chat de `movie` y `tv` | Razona por defecto y esos tokens cuentan contra `max_tokens`: vaciaba respuestas de la puntuación y, en el chat, 2 de 6 respuestas medidas; con más tope, la primera palabra tardaba hasta 6,3 s sin elegir mejor. `weekend` y `month` podrán activarlo | 3, 4 |

---

## Preguntas abiertas

Ordenadas por la fase que las bloquea. El detalle está en cada archivo.

| # | Pregunta | Bloquea |
|---|---|---|
| 1 | ¿Debe `anon` poder leer la columna `embedding`? | [Fase 2](fase-2-base-de-datos.md) |
| 2 | `autumn_score` varía según el lote en la franja media: ¿puntuar varias veces y promediar? ([detalle](fase-3-seed-corpus.md)) | [Fase 4](fase-4-api-chat.md) |
| 3 | La instrucción de la consulta dice «autumnal» y sesga hacia títulos con «otoño»: ¿cambiarla? ([detalle](fase-3-seed-corpus.md)) | [Fase 4](fase-4-api-chat.md) |
| 4 | ¿Qué historial ve un usuario sin cuenta, si no hay `localStorage`? | [Fase 4](fase-4-api-chat.md) |
| 5 | ¿Auth por SSR con cookies o cliente de Supabase en el navegador? | [Fase 5](fase-5-frontend.md) |
| 6 | ¿Isla de framework para el chat o JavaScript a pelo? | [Fase 5](fase-5-frontend.md) |
| 7 | ¿Dónde corre el servicio de embeddings en producción? | [Fase 6](fase-6-pulido-despliegue.md) |

---

## Cómo mantener esto

- Al cerrar una fase, mover sus casillas de **Pendiente** a **Hecho** y cambiar
  el estado en la tabla de arriba
- Cuando se resuelve una pregunta abierta, no se borra: pasa a la tabla de
  decisiones de su fase con el motivo. El motivo es lo que evita volver a
  discutirlo dentro de tres meses
- Las decisiones que cambien el esquema o el stack van también a `CLAUDE.md`,
  que es la fuente de verdad técnica
