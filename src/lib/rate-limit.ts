/**
 * Rate limiting de `/api/chat`, con los contadores en Supabase (`rate_limits`).
 *
 * En Vercel cada petición puede caer en una instancia distinta, así que el
 * contador no puede vivir en memoria. `hit_rate_limit` cuenta en ventanas fijas
 * con un upsert atómico, y solo la puede llamar la secret key: con la
 * publishable, cualquiera podría gastar el cupo de otra IP.
 *
 * Con sesión se cuenta por usuario; sin ella, por IP. Si el contador no
 * responde, el chat tampoco: sin límite, el endpoint que cuesta dinero quedaría
 * abierto sin que nadie se enterase. La búsqueda depende de la misma base, así
 * que esto no añade ninguna caída que no hubiera ya.
 */
import { RateLimitError } from '@/lib/errors';
import { getSupabaseAdminClient, unwrap } from '@/lib/supabase';

export interface RateLimitRule {
  readonly windowSeconds: number;
  readonly limit: number;
}

const MINUTE = 60;
const DAY = 24 * 60 * 60;

/**
 * Cada respuesta tarda varios segundos en llegar: nadie escribe ocho mensajes
 * por minuto a mano. El límite diario es el techo del gasto por persona.
 */
export const USER_CHAT_LIMITS: readonly RateLimitRule[] = [
  { windowSeconds: MINUTE, limit: 8 },
  { windowSeconds: DAY, limit: 300 },
];

/**
 * Sin sesión, el diario es más bajo: crear una cuenta exige confirmar un email,
 * cambiar de IP no. Detrás de una IP puede haber varias personas (una oficina,
 * el CGNAT de un operador móvil), y por eso no es más bajo todavía.
 */
export const ANONYMOUS_CHAT_LIMITS: readonly RateLimitRule[] = [
  { windowSeconds: MINUTE, limit: 8 },
  { windowSeconds: DAY, limit: 60 },
];

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

function limitMessage(retryAfterSeconds: number, anonymous: boolean): string {
  // Solo la ventana diaria hace esperar más de un minuto.
  if (retryAfterSeconds <= MINUTE) {
    return `Vas muy deprisa. Espera ${formatWait(retryAfterSeconds)} y vuelve a escribir.`;
  }
  const message = `Has llegado al límite de mensajes de hoy. Podrás seguir en ${formatWait(retryAfterSeconds)}.`;
  return anonymous ? `${message} Con la sesión iniciada el límite es más alto.` : message;
}

export interface ChatRequester {
  /** `null` sin sesión. */
  readonly userId: string | null;
  /** IP de la petición. En Vercel la pone su proxy, así que el cliente no puede falsearla. */
  readonly clientAddress: string | null;
}

/** Cuenta un mensaje de chat. Lanza `RateLimitError` (429) si no cabe. */
export async function enforceChatRateLimit(requester: ChatRequester): Promise<void> {
  const { userId } = requester;
  const anonymous = userId === null;
  const rules = anonymous ? ANONYMOUS_CHAT_LIMITS : USER_CHAT_LIMITS;

  const retryAfterSeconds = unwrap(
    await getSupabaseAdminClient().rpc('hit_rate_limit', {
      p_key: userId === null ? clientKey(requester.clientAddress) : `user:${userId}`,
      p_window_seconds: rules.map((rule) => rule.windowSeconds),
      p_limits: rules.map((rule) => rule.limit),
    }),
  );

  if (retryAfterSeconds > 0) {
    throw new RateLimitError(limitMessage(retryAfterSeconds, anonymous), retryAfterSeconds);
  }
}
