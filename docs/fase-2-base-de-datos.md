# Fase 2 — Base de datos

**Estado:** ⏳ Pendiente
**Depende de:** [Fase 1](fase-1-scaffolding.md) ✅
**Actualizado:** 2026-09-29

## Objetivo

Dejar el esquema de Supabase creado, indexado y con RLS activado, de forma que
el corpus se pueda cargar en la [Fase 3](fase-3-seed-corpus.md) y consultar desde
la [Fase 4](fase-4-api-chat.md) sin tocar más SQL.

## Hecho

Nada todavía. Los tipos de TypeScript que reflejan este esquema ya existen en
`src/lib/database.types.ts`, escritos a partir del SQL documentado en
`CLAUDE.md`: si el esquema real cambia, hay que actualizarlos o regenerarlos.

## Pendiente

### Extensiones y tablas

- [ ] Activar la extensión `vector`
- [ ] Tabla `content` con `embedding VECTOR(1024)` — **1024, no 1536**: es la
      dimensión nativa de Qwen3-Embedding-0.6B
- [ ] Tabla `users_favorites` con `UNIQUE(user_id, content_id)`
- [ ] Tabla `conversations` con `messages JSONB`

### Índices

- [ ] Índice vectorial sobre `content.embedding` — **decisión pendiente**, ver
      pregunta 1
- [ ] Índices auxiliares que el MVP va a necesitar y no están en `CLAUDE.md`:
      `conversations(user_id, updated_at DESC)` para listar las conversaciones de
      un usuario, y `users_favorites(user_id)` para su lista de favoritos.
      `content.tmdb_id` ya queda indexado por ser `UNIQUE`

### Función de búsqueda

- [ ] `search_content(query_embedding VECTOR(1024), content_type, match_count, min_score)`
- [ ] Verificar que el filtro por `content_type` no impide usar el índice
      vectorial. Con `ORDER BY embedding <=> query` y un `WHERE` por tipo, el
      planificador puede acabar filtrando después de recuperar los vecinos, y
      devolver menos resultados de los pedidos
- [ ] Calibrar `min_score` con datos reales. El `0.5` por defecto es un valor
      puesto a ojo: con coseno sobre Qwen3 habrá que ver dónde cae de verdad el
      corte entre «encaja» y «no encaja»

### RLS

- [ ] `content`: lectura para todos (`anon` incluido), escritura solo con la
      secret key. El corpus es público
- [ ] `users_favorites`: `SELECT`, `INSERT` y `DELETE` restringidos a
      `auth.uid() = user_id`
- [ ] `conversations`: igual, `auth.uid() = user_id` en las cuatro operaciones
- [ ] Verificar que `search_content` respeta RLS. Es `LANGUAGE sql STABLE` sin
      `SECURITY DEFINER`, así que debería ejecutarse con los permisos de quien
      llama, pero hay que comprobarlo explícitamente
- [ ] Probar cada política con un token de otro usuario, no solo con la service
      key. Una política mal escrita no da error: da datos de más

### Mantenimiento

- [ ] Trigger para `conversations.updated_at`, que ahora solo tiene `DEFAULT NOW()`
      y no se actualiza al modificar la fila

## Decisiones tomadas

| Decisión | Motivo |
|---|---|
| `VECTOR(1024)` en vez de `VECTOR(1536)` | Dimensión nativa de Qwen3-Embedding-0.6B. El 1536 del diseño original venía de asumir un modelo de embeddings de DeepSeek que no existe |

## Preguntas abiertas

**1. ¿Índice vectorial ivfflat o HNSW?**
`CLAUDE.md` propone `ivfflat` con `lists = 100`, pero la heurística de pgvector
es `filas / 1000` hasta un millón de filas: para 5.000 títulos serían unas **5**
listas, no 100. Con 100 quedan ~50 filas por lista y el recall se degrada.
Las opciones son ajustar a `lists = 5`, o pasar a HNSW, que no hay que tunear,
da mejor recall y a este tamaño de corpus construye rápido. HNSW ocupa más y
escribe más lento, lo que aquí casi no importa: el corpus se carga una vez.

**2. ¿Migraciones versionadas o SQL a mano?**
Con el CLI de Supabase el esquema queda en `supabase/migrations/` dentro del
repo, reproducible y revisable en diff. Aplicarlo a mano en el dashboard es más
rápido ahora y deja el esquema sin rastro en git. Para un proyecto que va a
reindexar el corpus más de una vez, lo versionado sale mejor.

## Verificación

- `search_content` con un vector de prueba devuelve filas ordenadas por
  `similarity` descendente
- Un usuario autenticado no puede leer las conversaciones ni los favoritos de
  otro, comprobado con dos cuentas distintas
- Un cliente `anon` puede leer `content` pero no escribirlo
- `src/lib/database.types.ts` sigue cuadrando con el esquema real
