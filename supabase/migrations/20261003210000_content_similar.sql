-- «Más como esta»: los 12 títulos más parecidos a cada uno, calculados en el seed.
--
-- Sustituye a `similar_content` (20261003200000), que comparaba títulos con el
-- vector de búsqueda. Ese vector lleva el nombre del título, y dos títulos se
-- parecían por cómo se llaman: *Cuando Harry encontró a Sally* salía junto a
-- *Harry, un amigo que os quiere*, un thriller. `load-db.py` los calcula con un
-- vector de lo que cuenta cada título, sin su nombre (`plot_text`), que no se
-- guarda en la base: así no hacen falta otra columna de 1024 dimensiones ni otro
-- índice HNSW (unos 60 MB del plan gratuito). En la web es una lectura simple, y
-- los parecidos son exactos, no aproximados.

drop function public.similar_content(uuid, integer);

create table public.content_similar (
  content_id uuid not null references public.content (id) on delete cascade,
  -- 1 es el más parecido, ya reordenado como en el chat (parecido y otoño).
  rank       smallint not null check (rank between 1 and 30),
  similar_id uuid not null references public.content (id) on delete cascade,
  similarity double precision not null,
  primary key (content_id, rank),
  check (similar_id <> content_id)
);

comment on table public.content_similar is
  'Más como esta: los títulos más parecidos a cada uno. Lo calcula y carga scripts/seed/load-db.py.';

-- La clave primaria cubre las lecturas por `content_id`; falta el otro lado,
-- para el borrado en cascada de un título que sale del corpus.
create index content_similar_similar_id_idx on public.content_similar (similar_id);

-- Público en lectura, como el corpus. Sin políticas de escritura: solo la
-- secret key, desde el seed.
alter table public.content_similar enable row level security;

create policy "Los parecidos del corpus son de lectura pública"
  on public.content_similar
  for select
  to anon, authenticated
  using (true);
