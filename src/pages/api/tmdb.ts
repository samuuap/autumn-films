/**
 * GET /api/tmdb?content_id=<uuid>&region=ES — plataformas de un título del corpus.
 *
 * Es el único camino del navegador a TMDB, y acotado a propósito: recibe el id
 * del corpus, no rutas de TMDB. Un proxy libre dejaría a cualquiera usar nuestro
 * token para lo que quisiera. Por ahora solo hacen falta las plataformas (el
 * póster sale de `image.tmdb.org` y del corpus), y pasan por la misma caché que
 * el chat (`lookupPlatforms`), así que cada título llama a TMDB como mucho una
 * vez cada tres días.
 *
 * Sin `region`, la de `Accept-Language`, y si no, `ES`. La respuesta no depende
 * de la sesión: la CDN puede guardarla.
 */
import type { APIRoute } from 'astro';

import { REGION_PATTERN, UUID_PATTERN, errorResponse } from '@/lib/api';
import { NotFoundError, SupabaseError, ValidationError } from '@/lib/errors';
import { regionFromAcceptLanguage } from '@/lib/locale';
import { lookupPlatforms } from '@/lib/platforms';
import { getSupabaseClient } from '@/lib/supabase';
import { TMDB_DEFAULT_REGION } from '@/lib/tmdb';
import type { PlatformsResponse } from '@/lib/types';

/** Una hora en el navegador y un día en la CDN: las plataformas cambian cada pocas semanas. */
const CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400';

export const GET: APIRoute = async ({ url, request }) => {
  try {
    const contentId = url.searchParams.get('content_id');
    if (contentId === null || !UUID_PATTERN.test(contentId)) {
      throw new ValidationError('Falta el identificador del título, o no es válido.');
    }
    const region =
      url.searchParams.get('region') ??
      regionFromAcceptLanguage(request.headers.get('accept-language')) ??
      TMDB_DEFAULT_REGION;
    if (!REGION_PATTERN.test(region)) {
      throw new ValidationError('La región tiene que ser un código de dos letras, como «ES».');
    }

    // El corpus es de lectura pública: basta la publishable key.
    const { data, error } = await getSupabaseClient()
      .from('content')
      .select('id, type, tmdb_id')
      .eq('id', contentId)
      .maybeSingle();
    if (error !== null) throw new SupabaseError(error.message, error);
    if (data === null) throw new NotFoundError('Ese título no está en el catálogo.');
    if (data.type !== 'movie' && data.type !== 'tv') {
      throw new SupabaseError(`El título ${contentId} tiene un tipo desconocido: ${data.type}.`);
    }

    const { platforms, saved } = await lookupPlatforms(
      [{ id: data.id, type: data.type, tmdb_id: data.tmdb_id }],
      region,
    );
    // Esperarla aquí: en Vercel, lo que sigue en marcha tras responder puede no terminar.
    await saved;

    const body: PlatformsResponse = { content_id: data.id, region, platforms: platforms[0] ?? null };
    return Response.json(body, {
      // Sin plataformas porque TMDB no respondió: que no se quede en la CDN un día.
      headers: { 'Cache-Control': body.platforms === null ? 'no-store' : CACHE_CONTROL },
    });
  } catch (error: unknown) {
    return errorResponse(error, 'api/tmdb');
  }
};
