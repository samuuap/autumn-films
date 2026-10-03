-- «Más como esta» en la ficha de `/explorar/<id>`: los títulos más parecidos a
-- uno del corpus, del mismo tipo, por su propio vector.
--
-- No vectoriza nada: el vector del título ya está en `content`, así que no hay
-- llamada al servicio de embeddings ni a DeepSeek. Es una búsqueda en el índice
-- HNSW, con los mismos parámetros que `search_content` (ver 20261003190000).
--
-- Devuelve por similitud; el orden final (parecido y otoño) lo da la app, como
-- en el chat. Expuesta a `anon`, como el resto del corpus, y con tope de 30.

-- Carga pgvector en la sesión para que `hnsw.*` se valide (ver 20260929235200).
select extensions.vector_dims('[1]'::extensions.vector);

create function public.similar_content(
  p_id    uuid,
  p_limit integer default 24
)
returns table (
  id           uuid,
  type         text,
  title        text,
  title_en     text,
  year         integer,
  poster_path  text,
  autumn_score double precision,
  similarity   double precision
)
language plpgsql
stable
set search_path = public, extensions
set hnsw.iterative_scan = strict_order
set hnsw.ef_search = 100
as $$
declare
  v_embedding extensions.vector;
  v_type      text;
begin
  select c.embedding, c.type into v_embedding, v_type
  from public.content c
  where c.id = p_id;

  -- Un id que no existe, o un título sin vectorizar: nada que comparar.
  if v_embedding is null then
    return;
  end if;

  -- El vector va en una variable para que el orden sea contra un valor fijo y
  -- el planificador use el índice.
  return query
    select c.id, c.type, c.title, c.title_en, c.year, c.poster_path, c.autumn_score,
           1 - (c.embedding <=> v_embedding) as similarity
    from public.content c
    where c.id <> p_id
      and c.type = v_type
      and c.embedding is not null
    order by c.embedding <=> v_embedding
    limit least(greatest(coalesce(p_limit, 24), 1), 30);
end;
$$;

revoke execute on function public.similar_content(uuid, integer) from public;
grant execute on function public.similar_content(uuid, integer) to anon, authenticated, service_role;
