/**
 * Sesión de Supabase en cada petición: crea el cliente con las cookies, verifica
 * (y si hace falta renueva) la sesión, y deja ambos en `Astro.locals`.
 */
import { defineMiddleware } from 'astro:middleware';

import { getSessionUser } from '@/lib/auth';
import { createSupabaseServerClient } from '@/lib/supabase';

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
  const responseHeaders = new Headers();
  const supabase = createSupabaseServerClient({
    request: context.request,
    cookies: context.cookies,
    responseHeaders,
  });

  context.locals.supabase = supabase;
  context.locals.user = await getSessionUser(supabase);

  return withHeaders(await next(), responseHeaders);
});
