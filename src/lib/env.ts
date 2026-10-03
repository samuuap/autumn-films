/**
 * Punto único de acceso a las variables de entorno del servidor.
 *
 * El esquema y su validación viven en `astro.config.mjs` (`env.schema`), así que
 * Astro falla en build si falta alguna obligatoria. No leer `process.env` ni
 * `import.meta.env` directamente en ningún otro archivo.
 *
 * Este módulo es solo de servidor: importarlo desde código de cliente provoca un
 * error de build a propósito. Para el navegador, usar `src/lib/env.client.ts`.
 */
import {
  DEEPSEEK_API_KEY,
  EMBEDDINGS_API_KEY,
  EMBEDDINGS_MODEL,
  EMBEDDINGS_URL,
  SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_SECRET_KEY,
  SUPABASE_URL,
  TMDB_API_KEY,
  TMDB_READ_ACCESS_TOKEN,
} from 'astro:env/server';

import { ConfigError } from '@/lib/errors';

export const env = {
  deepseek: {
    apiKey: DEEPSEEK_API_KEY,
  },
  embeddings: {
    /**
     * Endpoint OpenAI-compatible. En producción, Cloudflare Workers AI; en local
     * sin conexión, `npm run embeddings`.
     */
    url: EMBEDDINGS_URL,
    /** El token de Cloudflare. Opcional: el servidor local no pide nada. */
    apiKey: EMBEDDINGS_API_KEY,
    /** Cómo llama el servicio a Qwen3-Embedding-0.6B: `@cf/qwen/qwen3-embedding-0.6b` en Cloudflare. */
    model: EMBEDDINGS_MODEL,
  },
  supabase: {
    url: SUPABASE_URL,
    publishableKey: SUPABASE_PUBLISHABLE_KEY,
    /** Bypassea RLS. Solo endpoints de servidor y scripts de administración. */
    secretKey: SUPABASE_SECRET_KEY,
  },
  tmdb: {
    /** Auth v3 por query param. Opcional: preferimos el bearer token v4. */
    apiKey: TMDB_API_KEY,
    readAccessToken: TMDB_READ_ACCESS_TOKEN,
  },
} as const;

/**
 * Devuelve la secret key o lanza si no está configurada. Usar solo donde de
 * verdad hace falta saltarse RLS.
 */
export function requireSupabaseSecretKey(): string {
  const key = env.supabase.secretKey;
  if (key === undefined || key.length === 0) {
    throw new ConfigError(
      'SUPABASE_SECRET_KEY no está configurada. Es obligatoria para operaciones de servidor que se saltan RLS.',
    );
  }
  return key;
}
