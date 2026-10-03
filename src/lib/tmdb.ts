/**
 * Cliente de TMDB (API v3 con autenticación bearer v4).
 *
 * Solo se usa desde el servidor: el navegador llama a `/api/tmdb`, nunca a TMDB
 * directamente. Las plataformas no se piden desde aquí sino con
 * `lookupPlatforms()` de `src/lib/platforms.ts`, que las cachea en Supabase.
 */
import { env } from '@/lib/env';
import { TmdbError, toError } from '@/lib/errors';
import type { ContentType } from '@/lib/types';

export const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
export const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p';

/** Región de streaming por defecto. Se puede sobreescribir por petición. */
export const TMDB_DEFAULT_REGION = 'ES';
export const TMDB_DEFAULT_LANGUAGE = 'es-ES';

export const TMDB_POSTER_SIZE = 'w500';
export const TMDB_BACKDROP_SIZE = 'original';

/** Plataformas y pósters en una sola llamada. */
export const TMDB_DEFAULT_APPEND = ['watch/providers'] as const;

// ─── Imágenes ────────────────────────────────────────────────────────────────

export function posterUrl(path: string | null, size: string = TMDB_POSTER_SIZE): string | null {
  return path === null || path.length === 0 ? null : `${TMDB_IMAGE_BASE_URL}/${size}${path}`;
}

export function backdropUrl(path: string | null, size: string = TMDB_BACKDROP_SIZE): string | null {
  return path === null || path.length === 0 ? null : `${TMDB_IMAGE_BASE_URL}/${size}${path}`;
}

// ─── Tipos de respuesta ──────────────────────────────────────────────────────

export interface TmdbGenre {
  readonly id: number;
  readonly name: string;
}

export interface TmdbWatchProvider {
  readonly provider_id: number;
  readonly provider_name: string;
  readonly logo_path: string | null;
  readonly display_priority: number;
}

/** Proveedores de una región concreta. `flatrate` es la suscripción. */
export interface TmdbWatchProviderRegion {
  readonly link?: string | undefined;
  readonly flatrate?: readonly TmdbWatchProvider[] | undefined;
  readonly free?: readonly TmdbWatchProvider[] | undefined;
  readonly ads?: readonly TmdbWatchProvider[] | undefined;
  readonly rent?: readonly TmdbWatchProvider[] | undefined;
  readonly buy?: readonly TmdbWatchProvider[] | undefined;
}

export interface TmdbWatchProviders {
  readonly results: Readonly<Record<string, TmdbWatchProviderRegion | undefined>>;
}

interface TmdbCommonDetails {
  readonly id: number;
  readonly overview: string | null;
  readonly genres?: readonly TmdbGenre[] | undefined;
  readonly poster_path: string | null;
  readonly backdrop_path: string | null;
  readonly vote_average?: number | undefined;
  readonly original_language?: string | undefined;
  readonly 'watch/providers'?: TmdbWatchProviders | undefined;
}

export interface TmdbMovieDetails extends TmdbCommonDetails {
  readonly title: string;
  readonly original_title?: string | undefined;
  readonly release_date?: string | undefined;
  readonly runtime: number | null;
  readonly status?: string | undefined;
}

export interface TmdbTvDetails extends TmdbCommonDetails {
  readonly name: string;
  readonly original_name?: string | undefined;
  readonly first_air_date?: string | undefined;
  readonly number_of_seasons?: number | undefined;
  readonly number_of_episodes?: number | undefined;
  readonly episode_run_time?: readonly number[] | undefined;
  readonly status?: string | undefined;
}

export type TmdbDetails = TmdbMovieDetails | TmdbTvDetails;

// ─── Peticiones ──────────────────────────────────────────────────────────────

export interface TmdbRequestOptions {
  /** Idioma de sinopsis y títulos. Por defecto `es-ES`. */
  readonly language?: string;
  /** Sub-recursos a incluir en la misma llamada. Por defecto `watch/providers`. */
  readonly append?: readonly string[];
  readonly signal?: AbortSignal;
}

async function tmdbFetch<T>(
  path: string,
  params: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<T> {
  const url = new URL(`${TMDB_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.tmdb.readAccessToken}`,
        Accept: 'application/json',
      },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error: unknown) {
    throw new TmdbError(`No se pudo contactar con TMDB: ${toError(error).message}`, 502, error);
  }

  if (!response.ok) {
    throw new TmdbError(
      `TMDB respondió ${String(response.status)} en ${path}.`,
      response.status === 404 ? 404 : 502,
    );
  }

  return (await response.json()) as T;
}

function buildParams(options: TmdbRequestOptions): Record<string, string> {
  const append = options.append ?? TMDB_DEFAULT_APPEND;
  const params: Record<string, string> = {
    language: options.language ?? TMDB_DEFAULT_LANGUAGE,
  };
  if (append.length > 0) {
    params['append_to_response'] = append.join(',');
  }
  return params;
}

export async function getMovieDetails(
  tmdbId: number,
  options: TmdbRequestOptions = {},
): Promise<TmdbMovieDetails> {
  return tmdbFetch<TmdbMovieDetails>(
    `/movie/${String(tmdbId)}`,
    buildParams(options),
    options.signal,
  );
}

export async function getTvDetails(
  tmdbId: number,
  options: TmdbRequestOptions = {},
): Promise<TmdbTvDetails> {
  return tmdbFetch<TmdbTvDetails>(`/tv/${String(tmdbId)}`, buildParams(options), options.signal);
}

/** Despacha a película o serie según el tipo del corpus. */
export async function getDetails(
  type: ContentType,
  tmdbId: number,
  options: TmdbRequestOptions = {},
): Promise<TmdbDetails> {
  return type === 'movie' ? getMovieDetails(tmdbId, options) : getTvDetails(tmdbId, options);
}

// ─── Plataformas ─────────────────────────────────────────────────────────────

/**
 * La misma plataforma revendida a través de otra tienda. TMDB la lista como
 * proveedor aparte: «HBO Max» y «HBO Max Amazon Channel» son lo mismo.
 */
const RESELLER_SUFFIX = /\s+(?:Amazon|Apple TV|Roku|Verizon|Plex)\s+Channel$/u;

function cleanProviderName(name: string): string {
  return name.replace(RESELLER_SUFFIX, '').trim();
}

/**
 * Nombres de plataformas de suscripción (y gratuitas) de la región, ordenados
 * por la prioridad que da TMDB. Es lo que Umber menciona en su respuesta;
 * alquiler y compra se omiten.
 *
 * Los datos de TMDB vienen sucios y hay que normalizarlos, o Umber acaba
 * recitando seis plataformas que en realidad son tres: hay nombres con espacios
 * sobrantes, la misma plataforma repetida como canal de un revendedor, y
 * subservicios que son variantes de otro ya listado («Movistar Plus+ Ficción
 * Total» cuando ya está «Movistar Plus+»).
 */
function streamingNames(providers: TmdbWatchProviderRegion): string[] {
  const relevant = [...(providers.flatrate ?? []), ...(providers.free ?? [])];

  // Nombre limpio → mejor prioridad de sus duplicados.
  const priorityByName = new Map<string, number>();
  for (const provider of relevant) {
    const name = cleanProviderName(provider.provider_name);
    if (name.length === 0) continue;

    const known = priorityByName.get(name);
    if (known === undefined || provider.display_priority < known) {
      priorityByName.set(name, provider.display_priority);
    }
  }

  const names = [...priorityByName.entries()]
    .sort(([, a], [, b]) => a - b)
    .map(([name]) => name);

  // Fuera las variantes largas de una plataforma que ya está en la lista.
  return names.filter(
    (name) => !names.some((other) => other !== name && name.startsWith(`${other} `)),
  );
}

/**
 * Región (ISO 3166-1, «ES») → lo que devuelve `streamingNames`. Las regiones
 * sin ninguna plataforma de suscripción ni gratis no aparecen, igual que en TMDB.
 */
export type PlatformsByRegion = Record<string, string[]>;

/** Las de todas las regiones: TMDB las manda juntas en la misma respuesta. */
export function getStreamingNamesByRegion(details: TmdbDetails): PlatformsByRegion {
  const byRegion: PlatformsByRegion = {};
  for (const [region, providers] of Object.entries(details['watch/providers']?.results ?? {})) {
    if (providers === undefined) continue;
    const names = streamingNames(providers);
    if (names.length > 0) byRegion[region] = names;
  }
  return byRegion;
}

/** TMDB enriquece, no es imprescindible: si tarda más, se sigue sin plataformas. */
export const TMDB_PLATFORMS_TIMEOUT_MS = 2000;

export interface PlatformLookup {
  readonly type: ContentType;
  readonly tmdb_id: number;
}

/**
 * Plataformas de varios títulos a la vez, en paralelo y con un tope de tiempo
 * común. Devuelve `null` en los que TMDB no respondió, para que quien lo use
 * distinga «no está en ninguna plataforma» de «no lo sabemos».
 */
export async function fetchPlatformsByRegion(
  items: readonly PlatformLookup[],
  signal?: AbortSignal,
): Promise<(PlatformsByRegion | null)[]> {
  const timeout = AbortSignal.timeout(TMDB_PLATFORMS_TIMEOUT_MS);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

  const results = await Promise.allSettled(
    items.map(async (item) =>
      getStreamingNamesByRegion(await getDetails(item.type, item.tmdb_id, { signal: combined })),
    ),
  );

  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length > 0 && signal?.aborted !== true) {
    console.warn(
      `[tmdb] Sin plataformas para ${String(failed.length)} de ${String(results.length)} títulos:`,
      failed[0]?.reason,
    );
  }

  return results.map((result) => (result.status === 'fulfilled' ? result.value : null));
}
