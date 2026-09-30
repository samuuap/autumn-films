/**
 * Idioma y región deducidos de `Accept-Language`, cuando la persona no los elige.
 */
import { isLocale, type Locale } from '@/lib/types';

/** Primera región explícita (`es-MX` → `MX`), si la hay. Decide las plataformas de TMDB. */
export function regionFromAcceptLanguage(header: string | null): string | null {
  for (const tag of header?.split(',') ?? []) {
    const region = /^[a-z]{2,3}-([a-z]{2})\b/iu.exec(tag.trim())?.[1]?.toUpperCase();
    if (region !== undefined) return region;
  }
  return null;
}

/** Idioma preferido, si es uno de los que tiene la interfaz. */
export function localeFromAcceptLanguage(header: string | null): Locale | null {
  const language = header?.split(',')[0]?.trim().slice(0, 2).toLowerCase();
  return isLocale(language) ? language : null;
}
