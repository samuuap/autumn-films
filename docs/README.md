# Estado del proyecto — Umber 🍂

Índice de fases. Cada archivo lleva lo hecho, lo pendiente, las decisiones
tomadas con su motivo y las preguntas abiertas de esa fase.

La documentación **técnica** (stack, esquema, convenciones, estética) está en
[`.claude/CLAUDE.md`](../.claude/CLAUDE.md). Aquí solo vive el estado del trabajo.

| Fase | Contenido | Estado |
|---|---|---|
| [1](fase-1-scaffolding.md) | Scaffolding y configuración base | ✅ Completada |
| [2](fase-2-base-de-datos.md) | Base de datos: esquema, pgvector y RLS | ⏳ Pendiente |
| [3](fase-3-seed-corpus.md) | Seed del corpus desde TMDB | ⏳ Pendiente |
| [4](fase-4-api-chat.md) | API del chat con streaming | ⏳ Pendiente |
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

---

## Preguntas abiertas

Ordenadas por la fase que las bloquea. El detalle está en cada archivo.

| # | Pregunta | Bloquea |
|---|---|---|
| 1 | ¿Índice vectorial ivfflat o HNSW? | [Fase 2](fase-2-base-de-datos.md) |
| 2 | ¿Migraciones versionadas con Supabase CLI o SQL aplicado a mano? | [Fase 2](fase-2-base-de-datos.md) |
| 3 | ¿Cómo se define «otoñal» y cómo se calcula `autumn_score`? | [Fase 3](fase-3-seed-corpus.md) |
| 4 | ¿Vectorizamos la sinopsis española, la inglesa o ambas? | [Fase 3](fase-3-seed-corpus.md) |
| 5 | ¿Qué historial ve un usuario sin cuenta, si no hay `localStorage`? | [Fase 4](fase-4-api-chat.md) |
| 6 | ¿Auth por SSR con cookies o cliente de Supabase en el navegador? | [Fase 5](fase-5-frontend.md) |
| 7 | ¿Isla de framework para el chat o JavaScript a pelo? | [Fase 5](fase-5-frontend.md) |
| 8 | ¿Dónde corre el servicio de embeddings en producción? | [Fase 6](fase-6-pulido-despliegue.md) |

---

## Cómo mantener esto

- Al cerrar una fase, mover sus casillas de **Pendiente** a **Hecho** y cambiar
  el estado en la tabla de arriba
- Cuando se resuelve una pregunta abierta, no se borra: pasa a la tabla de
  decisiones de su fase con el motivo. El motivo es lo que evita volver a
  discutirlo dentro de tres meses
- Las decisiones que cambien el esquema o el stack van también a `CLAUDE.md`,
  que es la fuente de verdad técnica
