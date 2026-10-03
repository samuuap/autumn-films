-- Nombre de usuario, único entre todas las cuentas.
--
-- Supabase Auth solo lo guardaría en los metadatos del usuario, sin unicidad:
-- dos cuentas podrían llamarse igual. Aquí vive en `profiles`, con UNIQUE.
--
-- El registro lo manda en los metadatos (`signUp({ options: { data: { username } } })`)
-- y los triggers lo copian tal cual: al crearse el usuario y cada vez que cambia.
-- Así metadatos y perfil no divergen, y la app puede leerlo de la sesión sin
-- consultar la tabla. Si el nombre ya es de otro o no cumple el formato, falla la
-- operación de Auth entera: no se crea la cuenta.
--
-- Sin `username` en los metadatos (usuarios de la Admin API, o el registro con
-- Google cuando llegue) el perfil queda con null.

create table public.profiles (
  id         uuid        primary key references auth.users (id) on delete cascade,
  -- En minúsculas: la app lo normaliza antes de mandarlo, y aquí se exige.
  username   text        unique check (username ~ '^[a-z0-9_]{3,20}$'),
  created_at timestamptz not null default now()
);

comment on table public.profiles is
  'Perfil de cada usuario. username es copia de auth.users.raw_user_meta_data->>''username''.';

alter table public.profiles enable row level security;

-- Sin políticas de escritura: solo escriben los triggers.
create policy "Cada usuario lee su perfil"
  on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

-- ─── Sincronización con auth.users ───────────────────────────────────────────
-- SECURITY DEFINER: el trigger lo dispara el rol de Auth, que no tiene permisos
-- sobre public.profiles.

create or replace function public.sync_profile_from_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, username)
  values (new.id, new.raw_user_meta_data ->> 'username')
  on conflict (id) do update set username = excluded.username;
  return new;
end;
$$;

revoke execute on function public.sync_profile_from_auth_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.sync_profile_from_auth_user();

-- También con la cuenta sin confirmar: registrarse otra vez con el mismo email
-- reescribe los metadatos.
create trigger on_auth_user_username_changed
  after update of raw_user_meta_data on auth.users
  for each row
  when ((new.raw_user_meta_data ->> 'username') is distinct from (old.raw_user_meta_data ->> 'username'))
  execute function public.sync_profile_from_auth_user();

-- Las cuentas que ya existían, sin nombre.
insert into public.profiles (id)
select id from auth.users
on conflict (id) do nothing;

-- ─── is_username_available ───────────────────────────────────────────────────
-- Para explicar por qué ha fallado un registro. SECURITY DEFINER porque, con
-- RLS, nadie ve los perfiles ajenos. Dice si un nombre está cogido y nada más:
-- ni de quién ni su email.

create or replace function public.is_username_available(p_username text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (select 1 from public.profiles where username = p_username);
$$;

comment on function public.is_username_available(text) is
  'true si nadie tiene ese nombre de usuario. Recibe el nombre ya normalizado.';

revoke execute on function public.is_username_available(text) from public;
grant execute on function public.is_username_available(text) to anon, authenticated, service_role;
