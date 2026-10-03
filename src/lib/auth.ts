/**
 * Identidad del usuario en páginas y endpoints.
 *
 * La sesión vive en cookies `httpOnly` (SSR, decisión de la Fase 5): el
 * middleware la lee en cada petición y deja el usuario en `Astro.locals.user`.
 * Los endpoints aceptan además `Authorization: Bearer <access_token>`, para
 * clientes que no son el navegador, como los scripts de verificación.
 */
import { AuthError, errorMessage } from '@/lib/errors';
import {
  createSupabaseUserClient,
  getSupabaseClient,
  type UmberSupabaseClient,
} from '@/lib/supabase';

/** Lo que las páginas necesitan saber de quien ha iniciado sesión. */
export interface SessionUser {
  readonly id: string;
  readonly email: string | null;
  /** `null` en las cuentas anteriores al nombre de usuario. */
  readonly username: string | null;
}

export const MIN_PASSWORD_CHARS = 8;
/** El límite de bcrypt, que es el que aplica Supabase Auth. */
export const MAX_PASSWORD_CHARS = 72;
/** El mismo formato que exige el `CHECK` de `profiles.username`. */
export const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/u;
/** Para el `pattern` del input: admite mayúsculas porque el servidor las pasa a minúsculas. */
export const USERNAME_INPUT_PATTERN = '[A-Za-z0-9_]{3,20}';

export type AuthFormField = 'username' | 'email' | 'password' | 'password_confirm';

export interface AuthFormError {
  readonly message: string;
  /** El campo al que se refiere, para pintarlo junto a él; `null`, arriba del formulario. */
  readonly field: AuthFormField | null;
}

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Si el nombre ya es de alguien. Un registro con un nombre cogido falla con un
 * error genérico de base de datos (lo rechaza el UNIQUE de `profiles`); esto
 * dice si fue por eso. Si no se puede saber, `false`: mejor el mensaje genérico
 * que uno falso.
 */
export async function isUsernameTaken(supabase: UmberSupabaseClient, username: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_username_available', { p_username: username });
  if (error !== null) {
    console.warn('[auth] No se ha podido comprobar el nombre de usuario:', error.message);
    return false;
  }
  return !data;
}

export interface RequestUser {
  readonly id: string;
  /** Cliente con la sesión del usuario: RLS se evalúa como él. */
  readonly client: UmberSupabaseClient;
}

/**
 * Usuario de la sesión en cookies, o `null`. `getClaims` verifica la firma en
 * local con las claves asimétricas del proyecto, sin llamada de red, y renueva el
 * token si ha caducado: por eso la llama el middleware en cada petición.
 */
export async function getSessionUser(supabase: UmberSupabaseClient): Promise<SessionUser | null> {
  try {
    const { data } = await supabase.auth.getClaims();
    const claims = data?.claims;
    if (claims === undefined || typeof claims.sub !== 'string' || claims.sub.length === 0) {
      return null;
    }
    // Los triggers de `profiles` lo mantienen igual que en la tabla: no hace falta consultarla.
    const username: unknown = claims.user_metadata?.['username'];
    return {
      id: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : null,
      username: typeof username === 'string' ? username : null,
    };
  } catch (error: unknown) {
    // Una cookie corrupta o un refresh token revocado no tumban la página: se
    // sigue como anónimo, que es lo que la persona tiene que ver.
    console.warn('[auth] Sesión ilegible, se sigue sin sesión:', errorMessage(error));
    return null;
  }
}

function readBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header === null) return null;

  const token = /^Bearer\s+(\S+)$/iu.exec(header.trim())?.[1];
  if (token === undefined) {
    throw new AuthError('La cabecera Authorization tiene que ser «Bearer <token>».');
  }
  return token;
}

/**
 * Destino tras iniciar sesión, solo si es una ruta de esta misma web. Un
 * `?next=https://otra-web.com` convertiría el login en una redirección abierta.
 */
export function safeRedirectPath(value: string | null, fallback = '/'): string {
  if (value === null || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return fallback;
  }
  return value;
}

/** Códigos de error de Supabase Auth que la persona puede resolver por sí misma. */
const AUTH_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  invalid_credentials: 'El email o la contraseña no son correctos.',
  email_not_confirmed: 'Falta confirmar la cuenta: revisa tu correo y abre el enlace que te enviamos.',
  weak_password: 'Esa contraseña es demasiado débil. Prueba con una más larga.',
  user_already_exists: 'Ya hay una cuenta con ese email. Inicia sesión.',
  email_exists: 'Ya hay una cuenta con ese email. Inicia sesión.',
  over_email_send_rate_limit: 'Hemos enviado demasiados correos seguidos. Prueba dentro de unos minutos.',
  over_request_rate_limit: 'Demasiados intentos seguidos. Prueba dentro de unos minutos.',
  validation_failed: 'Revisa el email: no parece válido.',
  email_address_invalid: 'Revisa el email: no parece válido.',
  signup_disabled: 'El registro está cerrado ahora mismo.',
};

/** Mensaje en español para un error de Supabase Auth. El detalle técnico va al log. */
export function authErrorMessage(error: { code?: string | undefined; message: string }): string {
  const known = error.code === undefined ? undefined : AUTH_ERROR_MESSAGES[error.code];
  if (known !== undefined) return known;
  console.warn('[auth] Error sin mensaje propio:', error.code, error.message);
  return 'No se ha podido completar. Prueba otra vez en un momento.';
}

export interface RequestUserContext {
  readonly request: Request;
  readonly locals: App.Locals;
}

/**
 * Usuario de la petición: el del token Bearer si lo hay y si no, el de la
 * sesión en cookies. Un token presente pero inválido o caducado es un 401, no un
 * usuario anónimo: así el cliente sabe que tiene que renovar la sesión en vez de
 * perder el historial sin enterarse.
 */
export async function getRequestUser(context: RequestUserContext): Promise<RequestUser | null> {
  const token = readBearerToken(context.request);

  if (token === null) {
    const user = context.locals.user;
    return user === null ? null : { id: user.id, client: context.locals.supabase };
  }

  const { data, error } = await getSupabaseClient().auth.getClaims(token);
  const userId: unknown = data?.claims.sub;
  if (error !== null || typeof userId !== 'string' || userId.length === 0) {
    throw new AuthError('La sesión no es válida o ha caducado.', error ?? undefined);
  }
  return { id: userId, client: createSupabaseUserClient(token) };
}
