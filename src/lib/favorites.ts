/**
 * Favoritos del usuario (`users_favorites`), siempre con su cliente: RLS decide
 * qué ve y qué toca cada uno.
 */
import { NotFoundError, SupabaseError } from '@/lib/errors';
import { unwrap, type UmberSupabaseClient } from '@/lib/supabase';
import type { ContentType } from '@/lib/types';

/** Código de Postgres para una violación de `unique`: ya estaba guardado. */
const UNIQUE_VIOLATION = '23505';
/** Violación de clave foránea: el título no existe en el corpus. */
const FOREIGN_KEY_VIOLATION = '23503';

export async function listFavoriteIds(client: UmberSupabaseClient): Promise<string[]> {
  const rows = unwrap(await client.from('users_favorites').select('content_id'));
  return rows.map((row) => row.content_id);
}

export interface FavoriteContent {
  readonly id: string;
  readonly tmdb_id: number;
  readonly type: ContentType;
  readonly title: string;
  readonly year: number | null;
  readonly director: string | null;
  readonly genres: readonly string[];
  readonly poster_path: string | null;
  readonly saved_at: string;
}

/** Favoritos con los datos del título, del último guardado al primero. */
export async function listFavorites(client: UmberSupabaseClient): Promise<FavoriteContent[]> {
  const rows = unwrap(
    await client
      .from('users_favorites')
      .select(
        'created_at, content:content_id (id, tmdb_id, type, title, year, director, genres, poster_path)',
      )
      .order('created_at', { ascending: false }),
  );

  return rows.flatMap((row) => {
    const content = row.content;
    // `type` sale como string del generador; el CHECK de la tabla garantiza el valor.
    if (content === null || (content.type !== 'movie' && content.type !== 'tv')) return [];
    return [
      {
        id: content.id,
        tmdb_id: content.tmdb_id,
        type: content.type,
        title: content.title,
        year: content.year,
        director: content.director,
        genres: content.genres ?? [],
        poster_path: content.poster_path,
        saved_at: row.created_at,
      },
    ];
  });
}

/** Guarda un favorito. Guardarlo dos veces no es un error. */
export async function addFavorite(
  client: UmberSupabaseClient,
  userId: string,
  contentId: string,
): Promise<void> {
  const { error } = await client
    .from('users_favorites')
    .insert({ user_id: userId, content_id: contentId });
  if (error === null || error.code === UNIQUE_VIOLATION) return;
  if (error.code === FOREIGN_KEY_VIOLATION) {
    throw new NotFoundError('Ese título no está en el catálogo.', error);
  }
  throw new SupabaseError(error.message, error);
}

/** Quita un favorito. Quitar uno que no estaba tampoco es un error. */
export async function removeFavorite(
  client: UmberSupabaseClient,
  contentId: string,
): Promise<void> {
  const { error } = await client.from('users_favorites').delete().eq('content_id', contentId);
  if (error !== null) throw new SupabaseError(error.message, error);
}
