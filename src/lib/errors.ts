/**
 * Errores tipados del dominio.
 *
 * Convención del proyecto: nunca `catch (e: any)`. Se captura como `unknown` y
 * se normaliza con `toError()`, o se envuelve en una de estas clases.
 */

export interface UmberErrorOptions {
  /** Código estable para logs y respuestas de API. */
  readonly code: string;
  /** Código HTTP sugerido si el error llega a un endpoint. */
  readonly status?: number;
  /** Error original, si este envuelve a otro. */
  readonly cause?: unknown;
}

/** Error base. Todo error propio del proyecto hereda de aquí. */
export class UmberError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, options: UmberErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.status = options.status ?? 500;
  }
}

/** Falta una variable de entorno o está mal configurada. */
export class ConfigError extends UmberError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: 'config_error', status: 500, cause });
  }
}

/** Fallo en la API de DeepSeek (chat o embeddings). */
export class DeepSeekError extends UmberError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: 'deepseek_error', status: 502, cause });
  }
}

/** Fallo en el servicio de embeddings (modelo local o endpoint remoto). */
export class EmbeddingError extends UmberError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: 'embedding_error', status: 502, cause });
  }
}

/** Fallo en Supabase: consulta, RPC o auth. */
export class SupabaseError extends UmberError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: 'supabase_error', status: 502, cause });
  }
}

/** Fallo en la API de TMDB. */
export class TmdbError extends UmberError {
  constructor(message: string, status?: number, cause?: unknown) {
    super(message, { code: 'tmdb_error', status: status ?? 502, cause });
  }
}

/** Input del usuario inválido antes de llegar al LLM o a la base de datos. */
export class ValidationError extends UmberError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: 'validation_error', status: 400, cause });
  }
}

/** Token de sesión ausente donde hace falta, mal formado o caducado. */
export class AuthError extends UmberError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: 'auth_error', status: 401, cause });
  }
}

/** El recurso no existe o RLS no deja verlo, que desde fuera es lo mismo. */
export class NotFoundError extends UmberError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: 'not_found', status: 404, cause });
  }
}

/**
 * Demasiadas peticiones seguidas. El mensaje ya está escrito para la persona.
 * Código `trial_used` si quien no tiene cuenta ha gastado su conversación de
 * prueba del día: la interfaz le ofrece registrarse en vez de un error.
 */
export class RateLimitError extends UmberError {
  /** Segundos hasta poder repetir: va en la cabecera `Retry-After`. */
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number, code: 'rate_limited' | 'trial_used' = 'rate_limited') {
    super(message, { code, status: 429 });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** La conversación ha llegado a su tope de mensajes: hay que empezar otra. */
export class ConversationFullError extends UmberError {
  constructor(message: string) {
    super(message, { code: 'conversation_full', status: 409 });
  }
}

export function isUmberError(value: unknown): value is UmberError {
  return value instanceof UmberError;
}

/** Normaliza cualquier valor capturado en un `catch` a un `Error` real. */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  return new Error(`Error no identificado: ${JSON.stringify(value)}`);
}

/** Mensaje legible de cualquier valor capturado. Nunca lanza. */
export function errorMessage(value: unknown): string {
  return toError(value).message;
}
