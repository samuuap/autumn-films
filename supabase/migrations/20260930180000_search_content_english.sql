-- search_content devuelve también `title_en` y `synopsis_en`.
--
-- - `title_en`: quien escribe en inglés recibía el título en español (*Siempre
--   queda el amor* en vez de *Always Be My Maybe*). Con los dos, Umber nombra el
--   del idioma en que responde, y el chat reconoce cualquiera de ellos.
-- - `synopsis_en`: 65 títulos del corpus no tienen sinopsis española, y el chat
--   la pedía en una segunda consulta. Así llega en la misma.
--
-- Cambiar las columnas de `returns table` exige borrar la función y crearla de
-- nuevo, así que aquí va entera: la guarda de dimensión (20260929224000) y la
-- búsqueda iterativa del índice (20260929235200) tienen que seguir.

-- Carga pgvector en la sesión para que `hnsw.iterative_scan` se valide contra su
-- definición real (ver 20260929235200).
select extensions.vector_dims('[1]'::extensions.vector);

drop function public.search_content(extensions.vector, text, integer, double precision);

create function public.search_content(
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
  title_en     text,
  year         integer,
  director     text,
  synopsis     text,
  synopsis_en  text,
  genres       text[],
  autumn_score double precision,
  poster_path  text,
  similarity   double precision
)
language plpgsql
stable
set search_path = public, extensions
-- Sin esto, el índice HNSW devuelve como mucho 40 filas y el filtro por tipo
-- actúa después: las búsquedas de series se quedaban en 2 o 3 candidatos.
set hnsw.iterative_scan = strict_order
as $$
declare
  dims integer := extensions.vector_dims(query_embedding);
begin
  -- Postgres no aplica el `vector(1024)` de la firma: sin esta guarda, un vector
  -- de otra dimensión devolvería 0 filas en silencio.
  if dims <> 1024 then
    raise exception
      'search_content espera un vector de 1024 dimensiones y recibió %', dims
      using errcode = '22000';
  end if;

  return query
    select c.id,
           c.tmdb_id,
           c.type,
           c.title,
           c.title_en,
           c.year,
           c.director,
           c.synopsis,
           c.synopsis_en,
           c.genres,
           c.autumn_score,
           c.poster_path,
           1 - (c.embedding <=> query_embedding)
    from public.content as c
    where c.embedding is not null
      and (content_type is null or c.type = content_type)
      and 1 - (c.embedding <=> query_embedding) > min_score
    order by c.embedding <=> query_embedding
    -- Tope defensivo: la función está expuesta por PostgREST a `anon`, y sin
    -- límite una sola llamada podría volcar el corpus entero.
    limit least(greatest(coalesce(match_count, 10), 1), 50);
end;
$$;

comment on function public.search_content is
  'Candidatos del corpus por similitud coseno. Umber no puede recomendar nada fuera de aquí.';

-- Explícito: al recrearla no se hereda nada de la función anterior.
grant execute on function public.search_content(extensions.vector, text, integer, double precision)
  to anon, authenticated, service_role;
