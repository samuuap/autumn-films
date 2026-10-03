/**
 * Rate limiting de `/api/chat` y `/api/search`, con los contadores en Supabase
 * (`rate_limits`).
 *
 * En Vercel cada petición puede caer en una instancia distinta, así que el
 * contador no puede vivir en memoria. `hit_rate_limit` cuenta en ventanas fijas
 * con un upsert atómico, y solo la puede llamar la secret key: con la
 * publishable, cualquiera podría gastar el cupo de otra IP.
 *
 * Con sesión se cuenta por usuario; sin ella, por IP. Cada ámbito lleva su
 * propia cuenta. Si el contador no responde, el endpoint tampoco: sin límite,
 * quedaría abierto sin que nadie se enterase. La búsqueda depende de la misma
 * base, así que esto no añade ninguna caída que no hubiera ya.
 */
import { RateLimitError } from '@/lib/errors';
import { getSupabaseAdminClient, unwrap } from '@/lib/supabase';
import { MAX_CONVERSATION_MESSAGES } from '@/lib/types';

export interface RateLimitRule {
  readonly windowSeconds: number;
  readonly limit: number;
}

const MINUTE = 60;
const DAY = 24 * 60 * 60;

export type RateLimitScope = 'chat' | 'search';

interface ScopeLimits {
  readonly user: readonly RateLimitRule[];
  readonly anonymous: readonly RateLimitRule[];
  /**
   * Entre todos: el techo del gasto total. Solo cuenta las peticiones que caben
   * en el límite de la persona; si contara las rechazadas, una sola IP
   * insistiendo agotaría el cupo de todos en segundos.
   */
  readonly global?: readonly RateLimitRule[];
  /** Lo que se cuenta, para el mensaje: «Has llegado al límite de {noun} de hoy». */
  readonly noun: string;
}

export const RATE_LIMITS: Readonly<Record<RateLimitScope, ScopeLimits>> = {
  /*
   * Cada respuesta tarda varios segundos en llegar: nadie escribe ocho mensajes
   * por minuto a mano. Decisión de producto (2026-10-03): con cuenta, 50 al día,
   * dos o tres conversaciones, y así ninguna cuenta sola agota el cupo global.
   * Sin cuenta, una conversación de prueba al día por conexión, como gancho para
   * registrarse: crear una cuenta exige confirmar un email, cambiar de IP no.
   * Detrás de una IP puede haber varias personas (una oficina, el CGNAT de un
   * operador móvil): comparten la prueba, y por eso es por día y no para siempre.
   */
  chat: {
    user: [
      { windowSeconds: MINUTE, limit: 8 },
      { windowSeconds: DAY, limit: 50 },
    ],
    anonymous: [
      { windowSeconds: MINUTE, limit: 8 },
      { windowSeconds: DAY, limit: MAX_CONVERSATION_MESSAGES / 2 },
    ],
    /*
     * Decisión de producto (2026-10-03): unos 0,30 USD de DeepSeek al día como
     * mucho. Un mensaje cuesta algo menos de 0,001 USD, estimado de lo que costó
     * puntuar el corpus con llamadas de tamaño parecido. Subirlo con el tráfico.
     */
    global: [{ windowSeconds: DAY, limit: 300 }],
    noun: 'mensajes',
  },
  /*
   * Sin DeepSeek: un embedding y una consulta. Más alto que el chat, pero con
   * techo, porque el servicio de embeddings es nuestro y se puede saturar.
   */
  search: {
    user: [
      { windowSeconds: MINUTE, limit: 30 },
      { windowSeconds: DAY, limit: 1000 },
    ],
    anonymous: [
      { windowSeconds: MINUTE, limit: 20 },
      { windowSeconds: DAY, limit: 300 },
    ],
    noun: 'búsquedas',
  },
};

// ─── Claves ──────────────────────────────────────────────────────────────────

/** Los ocho grupos de una IPv6, o `null` si no lo es. Admite `::` y una IPv4 al final. */
function ipv6Groups(address: string): string[] | null {
  const halves = (address.split('%')[0] ?? '').split('::');
  if (halves.length > 2) return null;

  const [head = [], tail = []] = halves.map((half) => (half === '' ? [] : half.split(':')));
  const last = tail.at(-1) ?? head.at(-1);
  // Una IPv4 al final (`::ffff:1.2.3.4`) ocupa dos grupos; para el /64 da igual cuáles.
  const ipv4Tail = last?.includes('.') === true;
  const size = head.length + tail.length + (ipv4Tail ? 1 : 0);
  const missing = 8 - size;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;

  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const hex = ipv4Tail ? groups.slice(0, -1) : groups;
  return hex.every((group) => /^[0-9a-f]{1,4}$/u.test(group)) ? groups : null;
}

/**
 * Clave de quien no ha iniciado sesión. Una IPv6 se cuenta por su /64, que es lo
 * que un proveedor asigna a cada conexión: dentro de él, cambiar de dirección es
 * gratis, y contar por dirección dejaría el límite en nada.
 */
export function clientKey(address: string | null): string {
  if (address === null || address.length === 0) return 'ip:unknown';
  const ip = address.trim().toLowerCase();

  // Una IPv4 escrita como IPv6 (`::ffff:1.2.3.4`) es la misma IPv4.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(ip)?.[1];
  if (mapped !== undefined) return `ip:${mapped}`;
  if (!ip.includes(':')) return `ip:${ip}`;

  const groups = ipv6Groups(ip);
  if (groups === null) return `ip:${ip}`;
  const prefix = groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/u, ''));
  return `ip:${prefix.join(':')}::/64`;
}

// ─── Límite ──────────────────────────────────────────────────────────────────

function formatWait(seconds: number): string {
  if (seconds < MINUTE) return seconds === 1 ? '1 segundo' : `${String(seconds)} segundos`;
  const minutes = Math.ceil(seconds / MINUTE);
  if (minutes < 60) return minutes === 1 ? '1 minuto' : `${String(minutes)} minutos`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? '1 hora' : `${String(hours)} horas`;
}

function limitError(scope: RateLimitScope, retryAfterSeconds: number, anonymous: boolean): RateLimitError {
  // Solo la ventana diaria hace esperar más de un minuto.
  if (retryAfterSeconds <= MINUTE) {
    return new RateLimitError(
      `Vas muy deprisa. Espera ${formatWait(retryAfterSeconds)} y vuelve a intentarlo.`,
      retryAfterSeconds,
    );
  }
  if (anonymous && scope === 'chat') {
    return new RateLimitError(
      `Ya has usado la conversación de prueba de hoy. Crea una cuenta gratis para seguir hablando con Umber, o vuelve en ${formatWait(retryAfterSeconds)}.`,
      retryAfterSeconds,
      'trial_used',
    );
  }
  const message = `Has llegado al límite de ${RATE_LIMITS[scope].noun} de hoy. Podrás seguir en ${formatWait(retryAfterSeconds)}.`;
  return new RateLimitError(
    anonymous ? `${message} Con la sesión iniciada el límite es más alto.` : message,
    retryAfterSeconds,
  );
}

export interface Requester {
  /** `null` sin sesión. */
  readonly userId: string | null;
  /** IP de la petición. En Vercel la pone su proxy, así que el cliente no puede falsearla. */
  readonly clientAddress: string | null;
}

/** Cuenta una petición en `key`. Devuelve 0 si cabe; si no, los segundos hasta poder repetir. */
async function hit(key: string, rules: readonly RateLimitRule[]): Promise<number> {
  return unwrap(
    await getSupabaseAdminClient().rpc('hit_rate_limit', {
      p_key: key,
      p_window_seconds: rules.map((rule) => rule.windowSeconds),
      p_limits: rules.map((rule) => rule.limit),
    }),
  );
}

/** Cuenta una petición del ámbito. Lanza `RateLimitError` (429) si no cabe. */
export async function enforceRateLimit(scope: RateLimitScope, requester: Requester): Promise<void> {
  const { userId } = requester;
  const anonymous = userId === null;
  const limits = RATE_LIMITS[scope];
  const rules = anonymous ? limits.anonymous : limits.user;
  const identity = userId === null ? clientKey(requester.clientAddress) : `user:${userId}`;

  const retryAfterSeconds = await hit(`${scope}:${identity}`, rules);
  if (retryAfterSeconds > 0) throw limitError(scope, retryAfterSeconds, anonymous);

  // Después, y no a la vez: ver `ScopeLimits.global`.
  if (limits.global === undefined) return;
  const globalRetryAfter = await hit(`${scope}:global`, limits.global);
  if (globalRetryAfter > 0) {
    throw new RateLimitError(
      `Umber ha llegado a su límite de ${limits.noun} de hoy. Podrás seguir en ${formatWait(globalRetryAfter)}.`,
      globalRetryAfter,
    );
  }
}
