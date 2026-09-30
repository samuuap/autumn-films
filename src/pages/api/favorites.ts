/**
 * POST   /api/favorites  { content_id }  — guarda un favorito
 * DELETE /api/favorites  { content_id }  — lo quita
 *
 * Exige sesión, y escribe con el cliente del usuario: RLS garantiza que nadie
 * toca los favoritos de otro.
 */
import type { APIRoute } from 'astro';

import { UUID_PATTERN, errorResponse, readJson } from '@/lib/api';
import { getRequestUser } from '@/lib/auth';
import { AuthError, ValidationError } from '@/lib/errors';
import { addFavorite, removeFavorite } from '@/lib/favorites';

function parseContentId(body: unknown): string {
  const value =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)['content_id']
      : undefined;
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ValidationError('Falta el título que guardar.');
  }
  return value;
}

function handler(action: 'add' | 'remove'): APIRoute {
  return async ({ request, locals }) => {
    try {
      const user = await getRequestUser({ request, locals });
      if (user === null) throw new AuthError('Inicia sesión para guardar favoritos.');

      const contentId = parseContentId(await readJson(request));
      if (action === 'add') await addFavorite(user.client, user.id, contentId);
      else await removeFavorite(user.client, contentId);

      return Response.json({ content_id: contentId, favorite: action === 'add' });
    } catch (error: unknown) {
      return errorResponse(error, 'api/favorites');
    }
  };
}

export const POST = handler('add');
export const DELETE = handler('remove');
