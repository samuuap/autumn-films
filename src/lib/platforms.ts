/**
 * Plataformas de cada título, con caché en Supabase (`platforms_cache`).
 *
 * Una llamada a TMDB trae las plataformas de todas las regiones: se guardan
 * todas y valen durante `PLATFORMS_CACHE_TTL_MS`. Pasado ese tiempo se vuelve a
 * preguntar, pero si TMDB no responde vale la entrada caducada: una lista de
 * hace unos días es mejor que ninguna.
 *
 * La caché es prescindible, igual que TMDB: si Supabase falla, se pregunta a
 * TMDB y ya. No es dato de ningún usuario, así que se lee y se escribe con la
 * secret key; la tabla no tiene políticas de RLS.
 */
import type { Json } from '@/lib/database.types';
import { SupabaseError, errorMessage } from '@/lib/errors';
import { getSupabaseAdminClient, unwrap } from '@/lib/supabase';
import { fetchPlatformsByRegion, type PlatformLookup, type PlatformsByRegion } from '@/lib/tmdb';

/**
 * Tres días. Las plataformas cambian cada pocas semanas, casi siempre a fin de
 * mes; más tiempo haría que Umber anunciara plataformas que ya no lo tienen.
 */
export const PLATFORMS_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/** Leer la caché tiene que costar menos que lo que ahorra: TMDB tarda 150–330 ms. */
const CACHE_READ_TIMEOUT_MS = 1000;
const CACHE_WRITE_TIMEOUT_MS = 2000;

export interface PlatformItem extends PlatformLookup {
  /** Id del título en `content`: la clave de la caché. */
  readonly id: string;
}

export interface PlatformsLookup {
  /** Una entrada por título, en el mismo orden. `null` si no se sabe. */
  readonly platforms: (string[] | null)[];
  /**
   * La escritura de lo que se ha pedido a TMDB. Nunca falla. Va aparte para que
   * quien llama la espere cuando no retrase nada, como mientras DeepSeek abre
   * el stream.
   */
  readonly saved: Promise<void>;
}

interface CacheEntry {
  readonly byRegion: PlatformsByRegion;
  readonly fresh: boolean;
}

/** La caché leída, por id del título. */
export type PlatformsCache = ReadonlyMap<string, CacheEntry>;

/** Lo que hay en `by_region`, si tiene la forma esperada. */
function parseByRegion(value: Json): PlatformsByRegion | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const byRegion: PlatformsByRegion = {};
  for (const [region, names] of Object.entries(value)) {
    if (!Array.isArray(names) || !names.every((name) => typeof name === 'string')) return null;
    byRegion[region] = names;
  }
  return byRegion;
}

/**
 * Lee la caché de esos títulos. Nunca falla: si Supabase no responde, devuelve
 * una caché vacía. Solo necesita los ids, así que se puede pedir a la vez que
 * los propios títulos y pasársela después a `lookupPlatforms`.
 */
export async function readPlatformsCache(
  ids: readonly string[],
  signal: AbortSignal | undefined,
): Promise<PlatformsCache> {
  if (ids.length === 0) return new Map();
  const timeout = AbortSignal.timeout(CACHE_READ_TIMEOUT_MS);
  try {
    const rows = unwrap(
      await getSupabaseAdminClient()
        .from('platforms_cache')
        .select('content_id, by_region, fetched_at')
        .in('content_id', ids)
        .abortSignal(signal === undefined ? timeout : AbortSignal.any([signal, timeout])),
    );

    const freshSince = Date.now() - PLATFORMS_CACHE_TTL_MS;
    const entries = new Map<string, CacheEntry>();
    for (const row of rows) {
      const byRegion = parseByRegion(row.by_region);
      if (byRegion === null) continue;
      entries.set(row.content_id, { byRegion, fresh: Date.parse(row.fetched_at) >= freshSince });
    }
    return entries;
  } catch (error: unknown) {
    if (signal?.aborted !== true) {
      console.warn('[platforms] Caché ilegible, se pregunta a TMDB:', errorMessage(error));
    }
    return new Map();
  }
}

async function writeCache(fetched: ReadonlyMap<string, PlatformsByRegion>): Promise<void> {
  if (fetched.size === 0) return;
  const fetchedAt = new Date().toISOString();
  try {
    const { error } = await getSupabaseAdminClient()
      .from('platforms_cache')
      .upsert(
        [...fetched].map(([contentId, byRegion]) => ({
          content_id: contentId,
          by_region: byRegion,
          fetched_at: fetchedAt,
        })),
        { onConflict: 'content_id' },
      )
      .abortSignal(AbortSignal.timeout(CACHE_WRITE_TIMEOUT_MS));
    if (error !== null) throw new SupabaseError(error.message, error);
  } catch (error: unknown) {
    // La próxima vez se vuelve a preguntar a TMDB: no hay nada más que perder.
    console.warn('[platforms] No se pudo guardar la caché:', errorMessage(error));
  }
}

/**
 * Plataformas de suscripción y gratis de cada título en `region`. Solo pregunta
 * a TMDB por los que no están en la caché o han caducado. Con `cache`, usa la
 * que ya se pidió con `readPlatformsCache` en vez de leerla otra vez.
 */
export async function lookupPlatforms(
  items: readonly PlatformItem[],
  region: string,
  signal?: AbortSignal,
  cache?: Promise<PlatformsCache>,
): Promise<PlatformsLookup> {
  if (items.length === 0) return { platforms: [], saved: Promise.resolve() };

  const cached = await (cache ??
    readPlatformsCache(
      items.map((item) => item.id),
      signal,
    ));
  const pending = items.filter((item) => cached.get(item.id)?.fresh !== true);

  const fetched = new Map<string, PlatformsByRegion>();
  if (pending.length > 0) {
    const results = await fetchPlatformsByRegion(pending, signal);
    pending.forEach((item, index) => {
      const byRegion = results[index];
      if (byRegion !== null && byRegion !== undefined) fetched.set(item.id, byRegion);
    });
  }

  return {
    platforms: items.map((item) => {
      const byRegion = fetched.get(item.id) ?? cached.get(item.id)?.byRegion;
      return byRegion === undefined ? null : [...(byRegion[region] ?? [])];
    }),
    saved: writeCache(fetched),
  };
}
