-- Rate limiting de `/api/chat`, el endpoint que cuesta dinero en cada llamada.
--
-- En Vercel cada petición puede caer en una instancia distinta: un contador en
-- memoria no sirve. Aquí se cuenta en ventanas fijas, una fila por clave,
-- ventana e intervalo. La clave es `user:<uuid>` con sesión e `ip:<dirección>`
-- sin ella; los límites de cada una viven en `src/lib/rate-limit.ts`.
--
-- Ventanas fijas y no deslizantes: una sola fila por ventana y un upsert
-- atómico. El precio es que en el cambio de ventana caben hasta el doble de
-- peticiones seguidas, que para frenar abusos da igual.

create table public.rate_limits (
  key            text        not null,
  window_seconds integer     not null check (window_seconds > 0),
  window_start   timestamptz not null,
  expires_at     timestamptz not null,
  hits           integer     not null default 0,

  primary key (key, window_seconds, window_start)
);

comment on table public.rate_limits is
  'Peticiones por clave y ventana. Las claves incluyen IPs: cada fila se borra al caducar.';

-- Para borrar lo caducado sin recorrer la tabla.
create index rate_limits_expires_at_idx on public.rate_limits (expires_at);

-- Las claves son IPs e ids de usuario: nadie salvo el servidor debe verlas.
alter table public.rate_limits enable row level security;
revoke all on table public.rate_limits from anon, authenticated;

-- ─── hit_rate_limit ──────────────────────────────────────────────────────────
-- Cuenta una petición en cada ventana y devuelve 0 si cabe o, si alguna se ha
-- pasado, los segundos que faltan para que se pueda volver a intentar.
--
-- Las ventanas van en un array para que el límite corto y el largo cuesten una
-- sola llamada. Una petición rechazada también cuenta, pero no alarga el
-- bloqueo: la ventana termina a la misma hora.

create or replace function public.hit_rate_limit(
  p_key            text,
  p_window_seconds integer[],
  p_limits         integer[]
)
returns integer
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_now    timestamptz := now();
  v_retry  integer := 0;
  v_start  timestamptz;
  v_end    timestamptz;
  v_hits   integer;
begin
  if p_key is null or p_key = '' then
    raise exception 'hit_rate_limit: falta la clave' using errcode = '22023';
  end if;
  if coalesce(array_length(p_window_seconds, 1), 0) = 0
     or array_length(p_window_seconds, 1) is distinct from array_length(p_limits, 1) then
    raise exception 'hit_rate_limit: cada ventana necesita su límite' using errcode = '22023';
  end if;

  -- Lo caducado sobra, y guarda IPs. Con el índice, si no hay nada es una sola lectura.
  delete from public.rate_limits where expires_at <= v_now;

  for i in 1 .. array_length(p_window_seconds, 1) loop
    if p_window_seconds[i] is null or p_window_seconds[i] <= 0
       or p_limits[i] is null or p_limits[i] < 0 then
      raise exception 'hit_rate_limit: ventana o límite no válidos' using errcode = '22023';
    end if;

    -- Alineadas con la época: todas las peticiones del mismo minuto (o día, en
    -- UTC) caen en la misma fila.
    v_start := to_timestamp(
      floor(extract(epoch from v_now) / p_window_seconds[i]) * p_window_seconds[i]
    );
    v_end := v_start + make_interval(secs => p_window_seconds[i]);

    insert into public.rate_limits as r (key, window_seconds, window_start, expires_at, hits)
    values (p_key, p_window_seconds[i], v_start, v_end, 1)
    on conflict (key, window_seconds, window_start)
      do update set hits = r.hits + 1
    returning r.hits into v_hits;

    if v_hits > p_limits[i] then
      v_retry := greatest(v_retry, ceil(extract(epoch from v_end - v_now))::integer);
    end if;
  end loop;

  return v_retry;
end;
$$;

comment on function public.hit_rate_limit(text, integer[], integer[]) is
  'Cuenta una petición en cada ventana. 0 si cabe; si no, segundos hasta poder repetir.';

-- Supabase da EXECUTE a anon y authenticated en cada función nueva. Esta no:
-- con la publishable key cualquiera podría gastar el cupo de otra IP.
revoke execute on function public.hit_rate_limit(text, integer[], integer[])
  from public, anon, authenticated;
grant execute on function public.hit_rate_limit(text, integer[], integer[]) to service_role;
