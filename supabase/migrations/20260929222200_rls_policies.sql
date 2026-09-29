-- Row Level Security en las tres tablas.
--
-- El corpus es público en lectura; favoritos y conversaciones son privados de
-- cada usuario. Las escrituras sobre el corpus no tienen política: solo la
-- secret key, que se salta RLS, puede cargarlo.
--
-- `(select auth.uid())` en lugar de `auth.uid()` a propósito: envuelto en un
-- subselect, Postgres lo evalúa una vez por consulta y no una vez por fila.

-- ─── content ─────────────────────────────────────────────────────────────────

alter table public.content enable row level security;

create policy "El corpus es de lectura pública"
  on public.content
  for select
  to anon, authenticated
  using (true);

-- ─── users_favorites ─────────────────────────────────────────────────────────

alter table public.users_favorites enable row level security;

create policy "Cada usuario lee sus favoritos"
  on public.users_favorites
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Cada usuario añade sus favoritos"
  on public.users_favorites
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- Un favorito no se edita: se quita y se vuelve a poner. Sin política de update.
create policy "Cada usuario quita sus favoritos"
  on public.users_favorites
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- ─── conversations ───────────────────────────────────────────────────────────

alter table public.conversations enable row level security;

create policy "Cada usuario lee sus conversaciones"
  on public.conversations
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Cada usuario crea sus conversaciones"
  on public.conversations
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- El `with check` además del `using` impide reasignar una conversación a otro usuario.
create policy "Cada usuario actualiza sus conversaciones"
  on public.conversations
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Cada usuario borra sus conversaciones"
  on public.conversations
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);
