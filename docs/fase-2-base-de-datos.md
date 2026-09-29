# Fase 2 — Base de datos

**Estado:** ✅ Completada
**Depende de:** [Fase 1](fase-1-scaffolding.md) ✅
**Actualizado:** 2026-09-29

## Objetivo

Dejar el esquema de Supabase creado, indexado y con RLS activado, de forma que
el corpus se pueda cargar en la [Fase 3](fase-3-seed-corpus.md) y consultar desde
la [Fase 4](fase-4-api-chat.md) sin tocar más SQL.

## Hecho

### Herramientas

- [x] CLI de Supabase 2.118 como dependencia de desarrollo, y `supabase init`
- [x] Comandos: `npm run db:push`, `db:verify`, `db:types`

### Migraciones escritas

En `supabase/migrations/`, en orden de aplicación:

- [x] `20260929222000_initial_schema.sql` — extensión `vector`, las tres tablas,
      índice HNSW, índices auxiliares y trigger de `updated_at`
- [x] `20260929222100_search_content.sql` — la función de búsqueda semántica
- [x] `20260929222200_rls_policies.sql` — RLS y políticas

### SQL validado sin base de datos

No hay Docker ni Postgres en la máquina de desarrollo, así que las migraciones se
validaron con el parser de PostgreSQL compilado a WASM (`pg-query-emscripten`):

- [x] Las tres migraciones parsean sin errores — 26 sentencias en total
- [x] Auditoría del árbol de parseo: confirma `unique (tmdb_id, type)`,
      `unique (user_id, content_id)`, el índice HNSW con
      `extensions.vector_cosine_ops`, las dos funciones, RLS activado en las tres
      tablas y las 8 políticas con sus comandos y roles

Esto descarta los errores de sintaxis, que son la forma más probable de que
falle una migración escrita a mano. No valida la semántica: que el tipo
`extensions.vector` o `auth.users` existan solo se sabe al aplicarla.

### Verificación automatizada

- [x] `scripts/verify-schema.mjs` (`npm run db:verify`) — 15 comprobaciones
      contra el Data API: existencia de tablas, `search_content` con un vector de
      1024 dim, rechazo de dimensión incorrecta, lectura pública del corpus,
      bloqueo de escritura a `anon`, invisibilidad de favoritos y conversaciones,
      `unique (tmdb_id, type)`, checks de `type` y `mode`, validez de los modos
      `weekend` y `month`, y el trigger de `updated_at`. Borra sus datos de prueba
- [x] `scripts/verify-rls.mjs` (`npm run db:verify-rls`) — 16 comprobaciones de
      aislamiento entre dos usuarios reales: A ve lo suyo, B no ve, no modifica y
      no borra las filas de A, B no puede crear filas a nombre de A, y ningún
      usuario autenticado puede escribir en el corpus. Crea las dos cuentas con
      la Admin API y las borra al terminar
- [x] El camino de autenticación ya está probado end-to-end: crear usuario
      confirmado, iniciar sesión con contraseña y borrar usuario funcionan con
      las claves del proyecto. Eso desbloquea también la auth de la
      [Fase 5](fase-5-frontend.md)

## Aplicado y verificado

Aplicado sobre el proyecto `autumn-films` (Postgres 17.6, `eu-west-1`) con
`supabase db push`. Cuatro migraciones, ninguna con errores.

- [x] `npm run db:verify` → **18/18**
- [x] `npm run db:verify-rls` → **21/21**, incluido que B no ve, no modifica ni
      borra las filas de A, y que no puede crearlas a su nombre
- [x] `npm run db:types` — tipos regenerados desde el esquema real

## Decisiones tomadas

| Decisión | Motivo |
|---|---|
| Índice **HNSW** en lugar de ivfflat | No hay que dimensionar listas, da mejor recall y se puede crear sobre la tabla vacía. Con 5.000 filas, el `lists = 100` del diseño original dejaría ~50 filas por lista y degradaría la recuperación; la heurística de pgvector daría 5 |
| Migraciones versionadas con el **CLI de Supabase** | El esquema queda en el repo, revisable en diff y reproducible. Para un proyecto que va a reindexar el corpus más de una vez, compensa frente a aplicar SQL a mano en el dashboard |
| `unique (tmdb_id, type)` en vez de `tmdb_id unique` | TMDB numera películas y series en espacios independientes: `/movie/550` y `/tv/550` son obras distintas. Con la unicidad solo sobre `tmdb_id`, el seed de la Fase 3 habría rechazado series por colisionar con el id de una película. Los ids bajos colisionan con casi total seguridad |
| El tipo `vector` y la opclass van cualificados como `extensions.…` | No puedo aplicar las migraciones para probarlas, así que el DDL no debe depender de que `extensions` esté en el `search_path` de la sesión que las aplica |
| **No** fijar `hnsw.ef_search` en la función | Sería lo indicado contra el filtrado posterior, pero ese GUC solo existe si la biblioteca de pgvector está cargada en la sesión, y la migración podría fallar al crear la función. Es el primer parámetro que tocar cuando haya corpus para medir. **Superada en la Fase 3**: ver la fila siguiente |
| `hnsw.iterative_scan = strict_order` en `search_content` (Fase 3, migración `20260929235200`) | Resuelve la pregunta abierta 1. Medido con el corpus: con el plan genérico que PL/pgSQL acaba usando en las conexiones de PostgREST, 295 de 300 búsquedas de series se quedaban cortas (2,67 filas de media), y sin filtro nunca pasaba de 40. La búsqueda iterativa de pgvector 0.8.2 lo resuelve sin tocar `ef_search`. La migración carga antes la biblioteca para que el parámetro se valide contra su definición real, que era el riesgo de la fila anterior. Detalle en la [Fase 3](fase-3-seed-corpus.md) |
| `set search_path = public, extensions` en las funciones | Evita el secuestro de resolución de nombres y garantiza que el operador `<=>` de pgvector resuelva |
| `where embedding is not null` en `search_content` | Una fila sin vectorizar no debe aparecer nunca como candidata |
| Tope de `match_count` a 50 dentro de la función | Está expuesta por PostgREST a `anon`: sin límite, una sola llamada podría volcar el corpus |
| `(select auth.uid())` en las políticas, no `auth.uid()` | Envuelto en subselect, Postgres lo evalúa una vez por consulta en lugar de una vez por fila |
| Sin política de `update` en `users_favorites` | Un favorito no se edita: se quita y se vuelve a poner |
| Sin índice sobre `content(type)` ni sobre `users_favorites(user_id)` | El primero tiene dos valores en 5.000 filas: el planificador no lo usaría. El segundo ya está cubierto por el índice de `unique (user_id, content_id)`, cuyo prefijo es `user_id` |
| Guarda de dimensión en `search_content`, en PL/pgSQL | Postgres no aplica los modificadores de tipo a los parámetros de función: el `vector(1024)` de la firma no validaba nada. Un vector de otra dimensión entraba y, con el corpus vacío o el filtro descartando todo, la consulta devolvía 0 filas en silencio — indistinguible de «ningún título encaja». Lo detectó `db:verify`, no la revisión a ojo |
| Correcciones de tipos en `src/lib/types.ts`, no en el archivo generado | `supabase gen types` manda en la forma, pero no expresa los `CHECK` (salen como `string`) ni la nullabilidad de un `RETURNS TABLE` (devuelve todo como no nulable). Lo segundo es **inseguro**: dejaría pasar un `candidate.director.trim()` que reventaría en ejecución |

## Preguntas abiertas

**1. ~~¿Cuánto degrada el filtro posterior a la búsqueda vectorial?~~**
Resuelta en la Fase 3: mucho, y se corrigió con `hnsw.iterative_scan`. Ver la
tabla de decisiones.

**2. ¿Debe `anon` poder leer la columna `embedding`?**
La política de lectura del corpus permite `select` sobre todas las columnas, así
que cualquiera con la publishable key puede descargarse los 5.000 vectores, que
son el resultado de un trabajo de vectorización. Limitarlo requiere exponer una
vista sin esa columna y mover la política ahí. Para el MVP no es urgente, pero
conviene decidirlo antes de abrir al público.

## Verificación

```bash
npm run db:verify   # 18/18 con las migraciones aplicadas
npm run db:types    # el esquema real debe coincidir con database.types.ts
```
