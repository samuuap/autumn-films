-- Esquema inicial de Umber: corpus vectorial, favoritos y conversaciones.
--
-- La dimensión del vector (1024) es la nativa de Qwen3-Embedding-0.6B.
-- Cambiarla obliga a reindexar el corpus completo.

create extension if not exists vector with schema extensions;

-- El tipo y la opclass van cualificados con `extensions.` a propósito: así el
-- DDL no depende de que ese esquema esté en el search_path de la sesión que
-- aplica la migración.

-- ─── content ─────────────────────────────────────────────────────────────────
-- Corpus de películas y series. Lo carga el seed de la Fase 3 con la secret key.

create table public.content (
  id            uuid primary key default gen_random_uuid(),
  tmdb_id       integer not null,
  type          text    not null check (type in ('movie', 'tv')),
  title         text    not null,
  title_en      text,
  year          integer,
  director      text,
  synopsis      text,
  synopsis_en   text,
  genres        text[],
  keywords      text[],
  autumn_score  double precision,
  embedding     extensions.vector(1024),
  poster_path   text,
  backdrop_path text,
  runtime       integer,
  seasons       integer,
  status        text check (status in ('released', 'ended', 'ongoing')),
  created_at    timestamptz not null default now(),

  -- TMDB numera películas y series en espacios independientes: /movie/550 y
  -- /tv/550 son obras distintas. La unicidad tiene que incluir el tipo, o el
  -- seed rechazaría series por colisionar con el id de una película.
  constraint content_tmdb_id_type_key unique (tmdb_id, type)
);

comment on table public.content is
  'Corpus otoñal vectorizado. Umber solo puede recomendar títulos de esta tabla.';
comment on column public.content.embedding is
  'Qwen3-Embedding-0.6B, 1024 dim. Generado sin instrucción: son documentos.';
comment on column public.content.autumn_score is
  'Cuán otoñal es el título. Fórmula pendiente de definir en la Fase 3.';

-- Índice vectorial HNSW con distancia coseno, que es la que usa search_content.
-- HNSW y no ivfflat: no hay que dimensionar listas, da mejor recall y se puede
-- crear sobre la tabla vacía (ivfflat necesita datos para entrenarse).
create index content_embedding_hnsw_idx
  on public.content using hnsw (embedding extensions.vector_cosine_ops);

-- ─── users_favorites ─────────────────────────────────────────────────────────

create table public.users_favorites (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users (id) on delete cascade,
  content_id uuid references public.content (id) on delete cascade,
  created_at timestamptz not null default now(),

  unique (user_id, content_id)
);

-- La restricción unique ya indexa (user_id, content_id), así que las consultas
-- por user_id están cubiertas. Falta el otro lado, para el borrado en cascada.
create index users_favorites_content_id_idx on public.users_favorites (content_id);

-- ─── conversations ───────────────────────────────────────────────────────────

create table public.conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users (id) on delete cascade,
  mode       text not null check (mode in ('movie', 'tv', 'weekend', 'month')),
  messages   jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.conversations.mode is
  'Los 4 modos. weekend y month están diseñados para la v2 y no se eliminan.';

-- Para listar las conversaciones de un usuario, de la más reciente a la más antigua.
create index conversations_user_id_updated_at_idx
  on public.conversations (user_id, updated_at desc);

-- ─── updated_at ──────────────────────────────────────────────────────────────
-- Sin trigger, updated_at se quedaría en el valor del default para siempre.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row
  execute function public.set_updated_at();
