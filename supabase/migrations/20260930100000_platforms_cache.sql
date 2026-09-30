-- Caché de las plataformas de TMDB de cada título del corpus.
--
-- Una llamada a TMDB con `append_to_response=watch/providers` trae las
-- plataformas de todas las regiones a la vez, así que se guardan todas: quien
-- pregunte después desde otra región tampoco llama a TMDB. Se guarda el
-- resultado ya normalizado (suscripción y gratis, sin los duplicados de
-- revendedor), no la respuesta cruda: es lo único que usa la app y ocupa una
-- fracción.
--
-- Tabla aparte y no columnas en `content`:
--   - El corpus solo lo escribe el seed. La app no necesita permiso de escritura
--     sobre él, y un fallo en la caché no puede estropear un título.
--   - Cada fila caduca por su cuenta (`fetched_at`), sin tocar las filas del
--     corpus, que llevan el vector y el índice HNSW.
--
-- La caducidad la decide la app (`PLATFORMS_CACHE_TTL_MS` en
-- `src/lib/platforms.ts`): una fila caducada no se borra, porque si TMDB no
-- responde vale más una lista de hace unos días que ninguna.

create table public.platforms_cache (
  content_id uuid primary key references public.content (id) on delete cascade,
  -- Región (ISO 3166-1, «ES») → nombres de plataformas. Una región que no
  -- aparece no tiene ninguna de suscripción ni gratis, como en TMDB.
  by_region  jsonb       not null check (jsonb_typeof(by_region) = 'object'),
  fetched_at timestamptz not null default now()
);

comment on table public.platforms_cache is
  'Plataformas de TMDB por título y región, normalizadas. La lee y escribe el servidor con la secret key.';

-- Sin políticas: solo la secret key, que se salta RLS, la lee y la escribe. El
-- revoke es la segunda barrera, por si algún día se añade una política de más.
alter table public.platforms_cache enable row level security;
revoke all on table public.platforms_cache from anon, authenticated;
