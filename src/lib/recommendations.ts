/**
 * Fichas de títulos del corpus a partir de sus ids: las de una conversación
 * guardada, que solo recuerda qué recomendó Umber, no cómo era la ficha.
 *
 * Las plataformas se vuelven a pedir (por la caché de `lookupPlatforms`): pueden
 * haber cambiado desde la recomendación. Un título que ya no está en el corpus
 * se queda sin ficha.
 */
import { lookupPlatforms } from '@/lib/platforms';
import { getSupabaseClient, unwrap } from '@/lib/supabase';
import { posterUrl } from '@/lib/tmdb';
import type { ContentType, Locale, Recommendation } from '@/lib/types';

/** La ficha de un id con el título en `language`, o `null` si el título ya no está. */
export type RecommendationLookup = (id: string, language: Locale) => Recommendation | null;

/** Una consulta y una búsqueda de plataformas para todos los ids, por muchos mensajes que sean. */
export async function loadRecommendations(
  ids: readonly string[],
  region: string,
): Promise<RecommendationLookup> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return () => null;

  // El corpus es de lectura pública: basta la publishable key.
  const found = unwrap(
    await getSupabaseClient()
      .from('content')
      .select('id, tmdb_id, type, title, title_en, year, director, genres, poster_path')
      .in('id', unique),
  );
  // `type` sale como string del generador; el CHECK de la tabla garantiza el valor.
  const rows = found.flatMap((row) => {
    const type: ContentType | null = row.type === 'movie' || row.type === 'tv' ? row.type : null;
    return type === null ? [] : [{ ...row, type }];
  });

  const { platforms, saved } = await lookupPlatforms(rows, region);
  // Esperarla aquí: en Vercel, lo que sigue en marcha tras responder puede no terminar.
  await saved;

  const byId = new Map(rows.map((row, index) => [row.id, { row, platforms: platforms[index] ?? null }]));
  return (id, language) => {
    const entry = byId.get(id);
    if (entry === undefined) return null;
    const { row } = entry;
    return {
      id: row.id,
      tmdb_id: row.tmdb_id,
      type: row.type,
      title: language === 'en' ? (row.title_en ?? row.title) : row.title,
      year: row.year,
      director: row.director,
      genres: row.genres ?? [],
      poster_url: posterUrl(row.poster_path),
      platforms: entry.platforms,
    };
  };
}
