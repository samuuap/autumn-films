/**
 * El catálogo de `/explorar`: los filtros de la URL, el listado y la ficha de un
 * título. Las consultas viven en SQL (`explore_content` y `content_genres`), que
 * busca sin tildes ni mayúsculas. El corpus es de lectura pública: basta la
 * publishable key.
 */
import { UUID_PATTERN } from '@/lib/api';
import { getSupabaseClient, unwrap } from '@/lib/supabase';
import type { ContentStatus, ContentType, ExploreItem } from '@/lib/types';

export const EXPLORE_PATH = '/explorar';
/** Cabe entero en rejillas de 2, 3, 4 y 6 columnas. */
export const EXPLORE_PAGE_SIZE = 36;
const MAX_QUERY_CHARS = 100;

export const EXPLORE_SORTS = {
  autumn: 'Más otoñales',
  recent: 'Más recientes',
  title: 'Título (A–Z)',
} as const;
export type ExploreSort = keyof typeof EXPLORE_SORTS;
const DEFAULT_SORT: ExploreSort = 'autumn';

export interface ExploreFilters {
  readonly type: ContentType | null;
  readonly genre: string | null;
  readonly query: string;
  readonly sort: ExploreSort;
  readonly page: number;
}

function isSort(value: string | null): value is ExploreSort {
  return value !== null && Object.hasOwn(EXPLORE_SORTS, value);
}

/** Lo que no se entiende de la URL se ignora: un enlace viejo o tocado a mano sigue abriendo. */
export function parseExploreFilters(params: URLSearchParams): ExploreFilters {
  const type = params.get('type');
  const sort = params.get('sort');
  const page = Number.parseInt(params.get('page') ?? '', 10);
  return {
    type: type === 'movie' || type === 'tv' ? type : null,
    genre: params.get('genre')?.trim() || null,
    query: (params.get('q') ?? '').trim().slice(0, MAX_QUERY_CHARS),
    sort: isSort(sort) ? sort : DEFAULT_SORT,
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
  };
}

/** Parámetros de la URL, sin los que van por defecto: así los enlaces quedan cortos. */
export function exploreSearch(filters: ExploreFilters): string {
  const params = new URLSearchParams();
  if (filters.query !== '') params.set('q', filters.query);
  if (filters.type !== null) params.set('type', filters.type);
  if (filters.genre !== null) params.set('genre', filters.genre);
  if (filters.sort !== DEFAULT_SORT) params.set('sort', filters.sort);
  if (filters.page > 1) params.set('page', String(filters.page));
  const search = params.toString();
  return search === '' ? '' : `?${search}`;
}

/** Enlace al listado con algún filtro cambiado. Cambiar un filtro vuelve a la página 1. */
export function exploreHref(filters: ExploreFilters, changes: Partial<ExploreFilters> = {}): string {
  return `${EXPLORE_PATH}${exploreSearch({ ...filters, page: 1, ...changes })}`;
}

export function hasActiveFilters(filters: ExploreFilters): boolean {
  return filters.query !== '' || filters.type !== null || filters.genre !== null;
}

// ─── Listado ─────────────────────────────────────────────────────────────────

export interface GenreCount {
  readonly genre: string;
  readonly titles: number;
}

export async function listGenres(type: ContentType | null): Promise<GenreCount[]> {
  return unwrap(await getSupabaseClient().rpc('content_genres', type === null ? {} : { p_type: type }));
}

export interface ExplorePage {
  readonly items: readonly ExploreItem[];
  /** Títulos con estos filtros, en todas las páginas. */
  readonly total: number;
}

export async function listExplore(filters: ExploreFilters): Promise<ExplorePage> {
  const rows = unwrap(
    await getSupabaseClient().rpc('explore_content', {
      ...(filters.type === null ? {} : { p_type: filters.type }),
      ...(filters.genre === null ? {} : { p_genre: filters.genre }),
      ...(filters.query === '' ? {} : { p_query: filters.query }),
      p_sort: filters.sort,
      p_limit: EXPLORE_PAGE_SIZE,
      p_offset: (filters.page - 1) * EXPLORE_PAGE_SIZE,
    }),
  );
  // `type` sale como string del generador; el CHECK de la tabla garantiza el valor.
  const items = rows.flatMap((row): ExploreItem[] =>
    row.type === 'movie' || row.type === 'tv' ? [{ ...row, type: row.type }] : [],
  );
  // Pasada la última página no llegan filas, ni con ellas el total.
  return { items, total: rows[0]?.total_count ?? 0 };
}

// ─── Ficha ───────────────────────────────────────────────────────────────────

export interface ExploreTitle {
  readonly id: string;
  readonly tmdb_id: number;
  readonly type: ContentType;
  readonly title: string;
  readonly title_en: string | null;
  readonly year: number | null;
  readonly director: string | null;
  /** En español si la hay; si no, la inglesa. Todo título tiene al menos una. */
  readonly synopsis: string | null;
  readonly genres: readonly string[];
  readonly poster_path: string | null;
  readonly backdrop_path: string | null;
  readonly runtime: number | null;
  readonly seasons: number | null;
  readonly status: ContentStatus | null;
}

function isStatus(value: string | null): value is ContentStatus {
  return value === 'released' || value === 'ended' || value === 'ongoing';
}

/** `null` si el id no es de ningún título del corpus. */
export async function loadExploreTitle(id: string): Promise<ExploreTitle | null> {
  if (!UUID_PATTERN.test(id)) return null;
  // Sin `embedding`: son 1024 números que aquí no hacen falta.
  const row = unwrap(
    await getSupabaseClient()
      .from('content')
      .select(
        'id, tmdb_id, type, title, title_en, year, director, synopsis, synopsis_en, genres, poster_path, backdrop_path, runtime, seasons, status',
      )
      .eq('id', id)
      .limit(1),
  )[0];
  if (row === undefined || (row.type !== 'movie' && row.type !== 'tv')) return null;
  return {
    id: row.id,
    tmdb_id: row.tmdb_id,
    type: row.type,
    title: row.title,
    title_en: row.title_en,
    year: row.year,
    director: row.director,
    synopsis: row.synopsis ?? row.synopsis_en,
    genres: row.genres ?? [],
    poster_path: row.poster_path,
    backdrop_path: row.backdrop_path,
    runtime: row.runtime,
    seasons: row.seasons,
    status: isStatus(row.status) ? row.status : null,
  };
}
