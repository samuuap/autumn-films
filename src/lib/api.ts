/**
 * Piezas comunes de los endpoints de `src/pages/api/`: leer y validar la
 * entrada, y convertir errores tipados en respuestas que se pueden enseñar a la
 * persona.
 */
import type { APIContext } from 'astro';

import {
  AuthError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  isUmberError,
} from '@/lib/errors';
import type { ApiErrorBody } from '@/lib/types';

const GENERIC_ERROR = 'Algo ha fallado por nuestra parte. Prueba otra vez en un momento.';

/**
 * Lo que ve la persona según el tipo de error. Los mensajes de validación, auth,
 * «no existe» y límite ya están escritos para ella; los demás llevan detalles internos
 * (URLs, respuestas del proveedor) que se quedan en el log.
 */
const PUBLIC_MESSAGES: Readonly<Record<string, string>> = {
  embedding_error: 'El buscador de Umber no responde ahora mismo. Prueba otra vez en un momento.',
  deepseek_error: 'Umber no puede contestar ahora mismo. Prueba otra vez en un momento.',
  supabase_error: 'No se ha podido consultar el catálogo. Prueba otra vez en un momento.',
};

export interface PublicError {
  readonly status: number;
  readonly body: ApiErrorBody;
  /** `Retry-After` en un 429; vacío en el resto. */
  readonly headers: Readonly<Record<string, string>>;
}

export function publicError(error: unknown): PublicError {
  if (!isUmberError(error)) {
    return {
      status: 500,
      body: { error: { code: 'internal_error', message: GENERIC_ERROR } },
      headers: {},
    };
  }
  const userFacing =
    error instanceof ValidationError ||
    error instanceof AuthError ||
    error instanceof NotFoundError ||
    error instanceof RateLimitError;
  return {
    status: error.status,
    body: {
      error: {
        code: error.code,
        message: userFacing ? error.message : (PUBLIC_MESSAGES[error.code] ?? GENERIC_ERROR),
      },
    },
    headers:
      error instanceof RateLimitError ? { 'Retry-After': String(error.retryAfterSeconds) } : {},
  };
}

/** Respuesta JSON de error. Registra los 5xx, que son los que hay que mirar. */
export function errorResponse(error: unknown, scope: string): Response {
  const { status, body, headers } = publicError(error);
  if (status >= 500) console.error(`[${scope}]`, error);
  return Response.json(body, { status, headers });
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch (error: unknown) {
    throw new ValidationError('El cuerpo de la petición no es JSON válido.', error);
  }
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Región de plataformas, ISO 3166-1 alfa-2 en mayúsculas: `ES`, `MX`. */
export const REGION_PATTERN = /^[A-Z]{2}$/u;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Quita caracteres de control salvo saltos de línea y tabuladores, y recorta. */
function cleanText(text: string): string {
  return text.replace(/\r\n?/gu, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/gu, '').trim();
}

/** `field` en minúscula y con artículo («el mensaje»): va en mitad y al principio de frase. */
export function parseText(value: unknown, maxChars: number, field: string): string {
  const subject = field.charAt(0).toUpperCase() + field.slice(1);
  if (typeof value !== 'string') {
    throw new ValidationError(`Falta ${field}.`);
  }
  const text = cleanText(value);
  if (text.length === 0) {
    throw new ValidationError(`${subject} está vacío.`);
  }
  if (text.length > maxChars) {
    throw new ValidationError(
      `${subject} es demasiado largo: ${String(text.length)} caracteres, el máximo es ${String(maxChars)}.`,
    );
  }
  return text;
}

/** IP de la petición. Astro lanza si el adaptador no la conoce; en Vercel y en `astro dev` la conoce. */
export function readClientAddress(context: APIContext): string | null {
  try {
    return context.clientAddress;
  } catch {
    console.warn('[api] Petición sin IP: cuenta en el cupo compartido «ip:unknown».');
    return null;
  }
}
