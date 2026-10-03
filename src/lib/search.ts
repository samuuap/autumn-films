/**
 * Búsqueda semántica en el corpus: vectoriza la consulta, llama a
 * `search_content` y reordena combinando similitud y `autumn_score`.
 *
 * Las constantes están medidas con el corpus real; las medidas y su motivo están
 * en `docs/fase-4-api-chat.md`.
 */
import { isRecord, parseText } from '@/lib/api';
import { embedQuery, toPgVector } from '@/lib/embeddings';
import { ValidationError } from '@/lib/errors';
import { getSupabaseClient, unwrap } from '@/lib/supabase';
import { posterUrl } from '@/lib/tmdb';
import {
  MAX_MESSAGE_CHARS,
  MAX_SEARCH_RESULTS,
  type ContentCandidate,
  type ContentType,
  type SearchCandidateRef,
  type SearchResult,
} from '@/lib/types';

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

/**
 * Candidatos que se piden a la base para reordenar. `search_content` corta en
 * 50. Es también el tope de `/api/search`: más allá no hay nada reordenado.
 */
export const SEARCH_POOL_SIZE = MAX_SEARCH_RESULTS;

/**
 * Peso de `autumn_score` al reordenar. Con 0,2, frente a 0,1, cambian entre 0 y
 * 3 de los 10 primeros: su otoño medio sube de 0,58 a 0,61 y la similitud solo
 * baja de 0,437 a 0,434 (12 consultas). Era 0,1 mientras el score salía de una
 * sola pasada, con ruido de ±0,1 a ±0,4; ahora es la media de tres.
 */
export const AUTUMN_WEIGHT = 0.2;

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
 * Vectoriza `query` como consulta, busca en el corpus y devuelve los mejores
 * reordenados. `search_content` trae las dos sinopsis: 65 títulos no tienen la
 * española, y sin ninguna el modelo tendría que imaginarse la película.
 */
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
  );

  const exclude = options.exclude;
  return rows
    // `type` sale como string del generador: se comprueba en vez de suponerlo.
    .flatMap((row): ContentCandidate[] =>
      row.type === 'movie' || row.type === 'tv' ? [{ ...row, type: row.type }] : [],
    )
    .filter((candidate) => candidate.similarity >= SEARCH_MIN_SIMILARITY)
    .filter((candidate) => exclude === undefined || !exclude(candidate))
    .map((candidate) => ({ ...candidate, rank_score: rankScore(candidate) }))
    .sort((a, b) => b.rank_score - a.rank_score)
    .slice(0, options.limit ?? DEFAULT_CANDIDATE_COUNT);
}

/** Cómo se recuerda una búsqueda en la conversación: solo ids y similitud, en su orden. */
export function toCandidateRefs(candidates: readonly RankedCandidate[]): SearchCandidateRef[] {
  return candidates.map(({ id, similarity }) => ({ id, similarity }));
}

/**
 * Los candidatos de una búsqueda anterior, leídos de nuevo del corpus: es lo que
 * permite sacar «otra» sin volver a vectorizar. Mantienen el orden en que
 * salieron; uno que ya no está en el corpus se pierde.
 */
export async function loadCandidates(
  refs: readonly SearchCandidateRef[],
): Promise<RankedCandidate[]> {
  if (refs.length === 0) return [];
  const rows = unwrap(
    await getSupabaseClient()
      .from('content')
      .select(
        'id, tmdb_id, type, title, title_en, year, director, synopsis, synopsis_en, genres, autumn_score, poster_path',
      )
      .in(
        'id',
        refs.map((ref) => ref.id),
      ),
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return refs.flatMap((ref) => {
    const row = byId.get(ref.id);
    // `type` sale como string del generador; el CHECK de la tabla garantiza el valor.
    if (row === undefined || (row.type !== 'movie' && row.type !== 'tv')) return [];
    const candidate: ContentCandidate = { ...row, type: row.type, similarity: ref.similarity };
    return [{ ...candidate, rank_score: rankScore(candidate) }];
  });
}

// ─── POST /api/search ────────────────────────────────────────────────────────

export interface SearchRequest {
  readonly query: string;
  readonly contentType: ContentType | null;
  readonly limit: number;
}

/** Valida el cuerpo de `POST /api/search` (`SearchRequestBody`). */
export function parseSearchRequest(body: unknown): SearchRequest {
  if (!isRecord(body)) {
    throw new ValidationError('La petición tiene que ser un objeto JSON.');
  }

  const type = body['type'];
  if (type !== undefined && type !== 'movie' && type !== 'tv') {
    throw new ValidationError('El tipo tiene que ser «movie» o «tv».');
  }

  const limit = body['limit'];
  if (
    limit !== undefined &&
    (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS)
  ) {
    throw new ValidationError(
      `El límite tiene que ser un número entero de 1 a ${String(MAX_SEARCH_RESULTS)}.`,
    );
  }

  return {
    // Masculino: los mensajes de `parseText` dicen «está vacío».
    query: parseText(body['query'], MAX_MESSAGE_CHARS, 'el texto de búsqueda'),
    contentType: type ?? null,
    limit: limit ?? DEFAULT_CANDIDATE_COUNT,
  };
}

export function toSearchResult(candidate: RankedCandidate): SearchResult {
  return {
    id: candidate.id,
    tmdb_id: candidate.tmdb_id,
    type: candidate.type,
    title: candidate.title,
    title_en: candidate.title_en,
    year: candidate.year,
    director: candidate.director,
    genres: candidate.genres ?? [],
    synopsis: candidate.synopsis ?? candidate.synopsis_en,
    poster_url: posterUrl(candidate.poster_path),
    similarity: candidate.similarity,
    autumn_score: candidate.autumn_score,
    rank_score: candidate.rank_score,
  };
}
