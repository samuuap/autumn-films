-- Guarda de dimensión en search_content.
--
-- El `vector(1024)` de la firma no valida nada: Postgres no aplica los
-- modificadores de tipo a los parámetros de función. Un vector de otra dimensión
-- entra sin error, y si el corpus está vacío (o el filtro descarta todas las
-- filas) la consulta devuelve 0 resultados en silencio. En el chat eso se
-- confundiría con «ningún título encaja» en lugar de con un embedding mal
-- generado, que es un fallo mucho más difícil de diagnosticar.
--
-- Pasa a PL/pgSQL solo para poder lanzar el error explícito.

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
language plpgsql
stable
set search_path = public, extensions
as $$
declare
  dims integer := extensions.vector_dims(query_embedding);
begin
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
           c.year,
           c.director,
           c.synopsis,
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
