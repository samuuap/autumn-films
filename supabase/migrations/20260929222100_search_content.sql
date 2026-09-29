-- Búsqueda semántica sobre el corpus.
--
-- Se invoca por RPC desde `/api/chat` con el embedding del mensaje del usuario.
-- SECURITY INVOKER (el valor por defecto): se ejecuta con los permisos de quien
-- llama, así que RLS sobre `content` sigue aplicando.

create or replace function public.search_content(
  query_embedding extensions.vector(1024),
  content_type    text default null,
  match_count     integer default 10,
  min_score       double precision default 0.5
)
returns table (
  id           uuid,
  tmdb_id      integer,
  type         text,
  title        text,
  year         integer,
  director     text,
  synopsis     text,
  genres       text[],
  autumn_score double precision,
  poster_path  text,
  similarity   double precision
)
language sql
stable
-- search_path fijo: evita que se pueda secuestrar la resolución de nombres, y
-- garantiza que el operador `<=>` de pgvector resuelva.
--
-- Nota: `set hnsw.ef_search = 100` aquí sería tentador, porque el filtro por
-- tipo y por min_score se aplica DESPUÉS de que el índice devuelva candidatos.
-- Se deja fuera porque ese GUC solo existe cuando la biblioteca de pgvector
-- está cargada en la sesión, y la migración podría fallar al crear la función.
-- Es el primer parámetro que tocar si con corpus real la consulta devuelve
-- menos filas de las pedidas.
set search_path = public, extensions
as $$
  select c.id,
         c.tmdb_id,
         c.type,
         c.title,
         c.year,
         c.director,
         c.synopsis,
         c.genres,
         c.autumn_score,
         c.poster_path,
         1 - (c.embedding <=> query_embedding) as similarity
  from public.content as c
  where c.embedding is not null
    and (content_type is null or c.type = content_type)
    and 1 - (c.embedding <=> query_embedding) > min_score
  order by c.embedding <=> query_embedding
  -- Tope defensivo: la función está expuesta por PostgREST a `anon`, y sin
  -- límite una sola llamada podría volcar el corpus entero.
  limit least(greatest(coalesce(match_count, 10), 1), 50);
$$;

comment on function public.search_content is
  'Candidatos del corpus por similitud coseno. Umber no puede recomendar nada fuera de aquí.';
