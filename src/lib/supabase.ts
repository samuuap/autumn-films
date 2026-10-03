/**
 * Clientes de Supabase.
 *
 * Cuatro variantes, por orden de privilegio:
 *  - `getSupabaseClient()`          publishable key, respeta RLS. Lecturas del corpus.
 *  - `createSupabaseServerClient()` publishable key + sesión en cookies. La crea el
 *                                   middleware en cada petición: `Astro.locals.supabase`.
 *  - `createSupabaseUserClient()`   publishable key + JWT del usuario. RLS como el usuario.
 *  - `getSupabaseAdminClient()`     secret key, se salta RLS. Solo servidor.
 *
 * Solo el de cookies guarda sesión, y la guarda en la respuesta: en SSR cada
 * petición es independiente.
 */
import { createServerClient, parseCookieHeader } from '@supabase/ssr';
import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';
import type { AstroCookies } from 'astro';

import type { Database } from '@/lib/database.types';
import { env, requireSupabaseSecretKey } from '@/lib/env';
import { SupabaseError } from '@/lib/errors';

export type UmberSupabaseClient = SupabaseClient<Database>;

const SERVER_AUTH_OPTIONS = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false,
} as const;

let publishableClient: UmberSupabaseClient | undefined;
let adminClient: UmberSupabaseClient | undefined;

/** Cliente con la publishable key. Respeta RLS: solo ve lo que las políticas permiten. */
export function getSupabaseClient(): UmberSupabaseClient {
  publishableClient ??= createClient<Database>(env.supabase.url, env.supabase.publishableKey, {
    auth: { ...SERVER_AUTH_OPTIONS },
  });
  return publishableClient;
}

/**
 * Cliente con la secret key. Se salta RLS por completo, así que solo se usa en
 * endpoints de servidor y scripts de administración. Nunca en el cliente.
 */
export function getSupabaseAdminClient(): UmberSupabaseClient {
  adminClient ??= createClient<Database>(env.supabase.url, requireSupabaseSecretKey(), {
    auth: { ...SERVER_AUTH_OPTIONS },
  });
  return adminClient;
}

/**
 * Cliente que actúa en nombre del usuario autenticado: RLS se evalúa con su JWT.
 * Es el que hay que usar para leer y escribir conversaciones y favoritos.
 *
 * No se cachea: cada token es de un usuario distinto.
 */
export function createSupabaseUserClient(accessToken: string): UmberSupabaseClient {
  return createClient<Database>(env.supabase.url, env.supabase.publishableKey, {
    auth: { ...SERVER_AUTH_OPTIONS },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export interface CookieContext {
  readonly request: Request;
  readonly cookies: AstroCookies;
  /** Cabeceras que Supabase pide añadir a la respuesta cuando renueva la sesión. */
  readonly responseHeaders: Headers;
}

/**
 * Cliente con la sesión del navegador, guardada en cookies. Renueva el token
 * cuando caduca y escribe las cookies nuevas en la respuesta.
 *
 * Las cookies van `httpOnly`: nadie lee la sesión desde JavaScript, porque no
 * hay cliente de Supabase en el navegador. Un XSS no puede llevársela.
 */
export function createSupabaseServerClient(context: CookieContext): UmberSupabaseClient {
  const secure = new URL(context.request.url).protocol === 'https:';

  return createServerClient<Database>(env.supabase.url, env.supabase.publishableKey, {
    cookies: {
      getAll() {
        return parseCookieHeader(context.request.headers.get('cookie') ?? '');
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value, options } of cookiesToSet) {
          context.cookies.set(name, value, {
            path: options.path ?? '/',
            sameSite: options.sameSite ?? 'lax',
            httpOnly: true,
            secure,
            ...(options.maxAge === undefined ? {} : { maxAge: options.maxAge }),
            ...(options.expires === undefined ? {} : { expires: options.expires }),
          });
        }
        // `Cache-Control: private, no-store`: que ninguna CDN guarde una
        // respuesta que lleva la sesión de alguien.
        for (const [key, value] of Object.entries(headers)) {
          context.responseHeaders.set(key, value);
        }
      },
    },
  });
}

/**
 * Desempaqueta una respuesta de PostgREST y lanza `SupabaseError` tipado si hay
 * error. Evita el `if (error) ...` repetido en cada consulta.
 */
export function unwrap<T>(result: { data: T | null; error: PostgrestError | null }): T {
  if (result.error !== null) {
    throw new SupabaseError(result.error.message, result.error);
  }
  if (result.data === null) {
    throw new SupabaseError('Supabase no devolvió datos ni error.');
  }
  return result.data;
}
