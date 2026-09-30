/**
 * Búsqueda semántica en el corpus: vectoriza la consulta, llama a
 * `search_content` y reordena combinando similitud y `autumn_score`.
 *
 * Las constantes están medidas con el corpus real; las medidas y su motivo están
 * en `docs/fase-4-api-chat.md`.
 */
import { embedQuery, toPgVector } from '@/lib/embeddings';
import { getSupabaseClient, unwrap } from '@/lib/supabase';
import type { ContentCandidate, ContentType } from '@/lib/types';

/**
 * Suelo de similitud, no un umbral de «encaja». Con este modelo la similitud no
 * separa «nada encaja» de «encaja flojo»: «hola» llega a 0,39 y una petición
 * legítima de serie puede quedarse en 0,32, porque solo hay 500 series. El
 * suelo quita ruido; decidir si algo encaja es trabajo del modelo.
 *
 * Se aplica aquí y no en `search_content`: si pocas filas superan el umbral, la
 * búsqueda iterativa del índice sigue recorriéndolo para completar el LIMIT, y
 * puede llegar al timeout del rol `anon` (medido con 0,99: hasta 4,3 s, y un
 * timeout). Sin umbral se detiene en cuanto tiene las filas, y como llegan
 * ordenadas por similitud, filtrar después da exactamente el mismo resultado.
 */
export const SEARCH_MIN_SIMILARITY = 0.3;

/** `min_score` que se pasa a `search_content`: ninguno, ver `SEARCH_MIN_SIMILARITY`. */
const NO_DATABASE_THRESHOLD = -1;

/** Candidatos que se piden a la base para reordenar. `search_content` corta en 50. */
export const SEARCH_POOL_SIZE = 30;

/**
 * Peso de `autumn_score` al reordenar. Con 0,1 cambian entre 0 y 5 de los 10
 * primeros, y entran títulos que estaban entre el 11.º y el 26.º. Moderado a
 * propósito: el score tiene ruido de ±0,1 a ±0,4 en su franja media.
 */
export const AUTUMN_WEIGHT = 0.1;

/** Candidatos que se pasan al modelo por defecto. */
export const DEFAULT_CANDIDATE_COUNT = 10;

export interface RankedCandidate extends ContentCandidate {
  /** `similarity + AUTUMN_WEIGHT × autumn_score`: el orden con el que llega al modelo. */
  readonly rank_score: number;
}

export interface SearchOptions {
  /** `null` busca en películas y series. */
  readonly contentType: ContentType | null;
  /** Por defecto `DEFAULT_CANDIDATE_COUNT`. */
  readonly limit?: number;
  /** Se aplica antes de cortar, para que excluir no deje la lista corta. */
  readonly exclude?: (candidate: ContentCandidate) => boolean;
}

function rankScore(candidate: ContentCandidate): number {
  // Sin puntuar no suma: todo el corpus cargado tiene score, así que es teórico.
  return candidate.similarity + AUTUMN_WEIGHT * (candidate.autumn_score ?? 0);
}

/**
 * `search_content` solo devuelve la sinopsis española, y 27 títulos del corpus
 * no la tienen. Sin sinopsis, el modelo tendría que imaginarse la película.
 */
async function fillMissingSynopses(candidates: RankedCandidate[]): Promise<RankedCandidate[]> {
  const missing = candidates.filter((candidate) => candidate.synopsis === null);
  if (missing.length === 0) return candidates;

  const rows = unwrap(
    await getSupabaseClient()
      .from('content')
      .select('id, synopsis_en')
      .in(
        'id',
        missing.map((candidate) => candidate.id),
      ),
  );
  const english = new Map(rows.map((row) => [row.id, row.synopsis_en]));
  return candidates.map((candidate) =>
    candidate.synopsis === null
      ? { ...candidate, synopsis: english.get(candidate.id) ?? null }
      : candidate,
  );
}

/** Vectoriza `query` como consulta, busca en el corpus y devuelve los mejores reordenados. */
export async function searchCandidates(
  query: string,
  options: SearchOptions,
): Promise<RankedCandidate[]> {
  const vector = await embedQuery(query);

  const rows = unwrap(
    await getSupabaseClient().rpc('search_content', {
      query_embedding: toPgVector(vector),
      match_count: SEARCH_POOL_SIZE,
      min_score: NO_DATABASE_THRESHOLD,
      ...(options.contentType === null ? {} : { content_type: options.contentType }),
    }),
  ) as ContentCandidate[];

  const exclude = options.exclude;
  const ranked = rows
    .filter((candidate) => candidate.similarity >= SEARCH_MIN_SIMILARITY)
    .filter((candidate) => exclude === undefined || !exclude(candidate))
    .map((candidate) => ({ ...candidate, rank_score: rankScore(candidate) }))
    .sort((a, b) => b.rank_score - a.rank_score)
    .slice(0, options.limit ?? DEFAULT_CANDIDATE_COUNT);

  return fillMissingSynopses(ranked);
}
