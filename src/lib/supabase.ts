/**
 * Clientes de Supabase.
 *
 * Tres variantes, por orden de privilegio:
 *  - `getSupabaseClient()`        publishable key, respeta RLS. Lecturas del corpus.
 *  - `createSupabaseUserClient()` publishable key + JWT del usuario. RLS como el usuario.
 *  - `getSupabaseAdminClient()`   secret key, se salta RLS. Solo servidor.
 *
 * Ningún cliente persiste sesión: en SSR cada petición es independiente.
 */
import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/database.types';
import { env, requireSupabaseSecretKey } from '@/lib/env';
import { SupabaseError } from '@/lib/errors';

export type UmberSupabaseClient = SupabaseClient<Database>;

/**
 * Claves públicas del proyecto, para verificar los JWT de usuario en local sin
 * llamar al servidor de auth en cada petición. Se deriva de `SUPABASE_URL` en
 * lugar de ser otra variable de entorno: así no pueden desincronizarse.
 * La consume la auth de la Fase 5.
 */
export const SUPABASE_JWKS_URL = `${env.supabase.url}/auth/v1/.well-known/jwks.json`;

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
