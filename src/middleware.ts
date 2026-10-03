/**
 * Sesión de Supabase en cada petición: crea el cliente con las cookies, verifica
 * (y si hace falta renueva) la sesión, y deja ambos en `Astro.locals`. Añade
 * también las cabeceras de seguridad a todas las respuestas.
 */
import { defineMiddleware } from 'astro:middleware';

import { getSessionUser } from '@/lib/auth';
import { createSupabaseServerClient } from '@/lib/supabase';

/**
 * El CSP no va aquí: lo genera Astro (`security.csp` en `astro.config.mjs`) y
 * una cabecera puesta aquí lo sustituiría. `X-Frame-Options` repite su
 * `frame-ancestors 'none'` para navegadores antiguos.
 */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
} as const;

/** Añade cabeceras a la respuesta, copiándola si sus cabeceras son inmutables (redirecciones). */
function withHeaders(response: Response, extra: Headers): Response {
  if (extra.keys().next().done === true) return response;
  try {
    extra.forEach((value, key) => {
      response.headers.set(key, value);
    });
    return response;
  } catch {
    const copy = new Response(response.body, response);
    extra.forEach((value, key) => {
      copy.headers.set(key, value);
    });
    return copy;
  }
}

export const onRequest = defineMiddleware(async (context, next) => {
  const responseHeaders = new Headers(SECURITY_HEADERS);
  const supabase = createSupabaseServerClient({
    request: context.request,
    cookies: context.cookies,
    responseHeaders,
  });

  context.locals.supabase = supabase;
  context.locals.user = await getSessionUser(supabase);

  return withHeaders(await next(), responseHeaders);
});
