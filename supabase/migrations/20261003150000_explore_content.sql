-- Explorar el corpus: listado con filtros y orden, y los géneros que hay.
--
-- En funciones y no con filtros de PostgREST: la búsqueda tiene que ignorar
-- tildes y mayúsculas («otono» encuentra «Otoño»), y el texto del usuario va como
-- parámetro, sin escaparlo dentro de una cadena de filtros.
--
-- SECURITY INVOKER (por defecto): el corpus ya es de lectura pública por RLS.

-- ─── fold_search_text ────────────────────────────────────────────────────────
-- Minúsculas y sin tildes. Con `translate` y no con la extensión unaccent: para
-- títulos en español e inglés basta, y es IMMUTABLE.

create or replace function public.fold_search_text(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select translate(lower(p_text), 'áàäâãåéèëêíìïîóòöôõúùüûñçý', 'aaaaaaeeeeiiiiooooouuuuncy');
$$;

-- ─── explore_content ─────────────────────────────────────────────────────────
-- Una página del listado y, en cada fila, el total con esos filtros (para la
-- paginación, sin una segunda consulta).
--
--   p_type   'movie' | 'tv' | null (todo)
--   p_genre  un género tal como está en `content.genres`, o null
--   p_query  texto en el título (español o inglés) o en el director, o null
--   p_sort   'autumn' (más otoñales) | 'recent' (más recientes) | 'title'

create or replace function public.explore_content(
  p_type   text    default null,
  p_genre  text    default null,
  p_query  text    default null,
  p_sort   text    default 'autumn',
  p_limit  integer default 36,
  p_offset integer default 0
)
returns table (
  id           uuid,
  type         text,
  title        text,
  title_en     text,
  year         integer,
  poster_path  text,
  autumn_score double precision,
  total_count  bigint
)
language sql
stable
set search_path = ''
as $$
  with params as (
    select
      -- `%` y `_` del usuario son texto, no comodines.
      '%' || replace(replace(replace(public.fold_search_text(btrim(p_query)), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        as pattern
  )
  select c.id, c.type, c.title, c.title_en, c.year, c.poster_path, c.autumn_score,
         count(*) over () as total_count
    from public.content c, params
   where (p_type is null or c.type = p_type)
     and (p_genre is null or p_genre = any (c.genres))
     and (
       nullif(btrim(p_query), '') is null
       or public.fold_search_text(c.title) like params.pattern
       or public.fold_search_text(c.title_en) like params.pattern
       or public.fold_search_text(c.director) like params.pattern
     )
   order by
     case when p_sort = 'recent' then c.year end desc nulls last,
     case when p_sort = 'title' then public.fold_search_text(c.title) end asc,
     c.autumn_score desc nulls last,
     c.id
   -- Expuesta a anon: sin páginas enormes.
   limit least(greatest(coalesce(p_limit, 36), 1), 60)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.explore_content(text, text, text, text, integer, integer) is
  'Listado del corpus para /explorar, con el total de filas en total_count.';

-- ─── content_genres ──────────────────────────────────────────────────────────

create or replace function public.content_genres(p_type text default null)
returns table (genre text, titles bigint)
language sql
stable
set search_path = ''
as $$
  select g.genre, count(*) as titles
    from public.content c, unnest(c.genres) as g (genre)
   where p_type is null or c.type = p_type
   group by g.genre
   order by public.fold_search_text(g.genre);
$$;

comment on function public.content_genres(text) is
  'Géneros del corpus con cuántos títulos tiene cada uno, por orden alfabético.';

revoke execute on function public.explore_content(text, text, text, text, integer, integer) from public;
revoke execute on function public.content_genres(text) from public;
grant execute on function public.explore_content(text, text, text, text, integer, integer)
  to anon, authenticated, service_role;
grant execute on function public.content_genres(text) to anon, authenticated, service_role;
