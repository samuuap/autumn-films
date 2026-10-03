-- Añadir mensajes a una conversación sin leerla antes.
--
-- El chat leía el array, le añadía el turno y lo reescribía entero: dos
-- peticiones a la vez sobre la misma conversación podían perder un turno, porque
-- la segunda escribía sobre lo que había leído antes de que la primera guardara.
-- Aquí el append lo hace Postgres en un solo UPDATE: la segunda petición espera
-- al bloqueo de la fila y concatena sobre la versión ya guardada.
--
-- SECURITY INVOKER (por defecto): corre con los permisos de quien llama, así que
-- la política de UPDATE de `conversations` decide. Sobre una conversación ajena
-- no actualiza nada y devuelve false, igual que si no existiera.

create or replace function public.append_conversation_messages(
  p_id       uuid,
  p_messages jsonb
)
returns boolean
language plpgsql
volatile
set search_path = ''
as $$
begin
  if jsonb_typeof(p_messages) is distinct from 'array' then
    raise exception 'append_conversation_messages: p_messages tiene que ser un array'
      using errcode = '22023';
  end if;

  -- `updated_at` lo pone el trigger `conversations_set_updated_at`.
  update public.conversations
     set messages = messages || p_messages
   where id = p_id;

  return found;
end;
$$;

comment on function public.append_conversation_messages(uuid, jsonb) is
  'Añade mensajes al final de una conversación propia. false si no existe o es de otro usuario.';

-- Sin sesión no hay conversaciones que tocar.
revoke execute on function public.append_conversation_messages(uuid, jsonb) from public, anon;
grant execute on function public.append_conversation_messages(uuid, jsonb) to authenticated, service_role;
