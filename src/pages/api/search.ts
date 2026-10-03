/**
 * POST /api/search — búsqueda semántica en el corpus, sin pasar por el modelo.
 *
 * Es la misma búsqueda que ve Umber (vectorizar, `search_content`, suelo de
 * similitud y reordenado con `autumn_score`), así que sirve para depurar por qué
 * el chat recomienda lo que recomienda. Contrato en `src/lib/types.ts`
 * (`SearchRequestBody`, `SearchResponse`).
 *
 * Tiene su propio rate limit: no gasta DeepSeek, pero sí el servicio de
 * embeddings, que es nuestro y se puede saturar.
 */
import type { APIRoute } from 'astro';

import { errorResponse, readClientAddress, readJson } from '@/lib/api';
import { getRequestUser } from '@/lib/auth';
import { enforceRateLimit } from '@/lib/rate-limit';
import { parseSearchRequest, searchCandidates, toSearchResult } from '@/lib/search';
import type { SearchResponse } from '@/lib/types';

export const POST: APIRoute = async (context) => {
  try {
    const search = parseSearchRequest(await readJson(context.request));
    const user = await getRequestUser({ request: context.request, locals: context.locals });
    await enforceRateLimit('search', {
      userId: user?.id ?? null,
      clientAddress: readClientAddress(context),
    });

    const found = await searchCandidates(search.query, {
      contentType: search.contentType,
      limit: search.limit,
    });
    const body: SearchResponse = { results: found.map(toSearchResult) };
    return Response.json(body);
  } catch (error: unknown) {
    return errorResponse(error, 'api/search');
  }
};
