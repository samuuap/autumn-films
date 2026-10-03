-- Las columnas de dueño eran nulables desde el esquema inicial. RLS ya impedía
-- que la app guardara nulos (el `with check` falla contra null), pero no la
-- secret key, y los tipos generados salían como `string | null`, obligando a
-- filtrar en la app nulos que no pueden existir. Una fila sin dueño no la ve
-- nadie ni se puede borrar desde la app: no tiene sentido que exista.
--
-- Comprobado antes de aplicar: ninguna fila con estas columnas a null.

alter table public.users_favorites
  alter column user_id set not null,
  alter column content_id set not null;

alter table public.conversations
  alter column user_id set not null;
