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

// Palabras frecuentes que solo son de uno de los dos idiomas. Fuera las que
// comparten («a», «me», «no», «mi», «series»), que no deciden nada.
const SPANISH_WORDS = new Set([
  'el', 'la', 'los', 'las', 'lo', 'de', 'del', 'que', 'qué', 'y', 'en', 'un', 'una', 'unos', 'por',
  'para', 'con', 'sin', 'es', 'está', 'estoy', 'algo', 'quiero', 'tienes', 'tengo', 'dame', 'otra',
  'otro', 'peli', 'película', 'pelis', 'serie', 'hola', 'muy', 'pero', 'como', 'cómo',
  'se', 'te', 'ver', 'hoy', 'noche', 'tarde', 'miedo', 'bonita', 'apetece', 'gracias', 'sí', 'mejor',
]);
const ENGLISH_WORDS = new Set([
  'the', 'an', 'and', 'of', 'to', 'in', 'for', 'with', 'without', 'is', 'it', 'i', "i'm", 'im', 'you',
  'my', 'something', 'want', 'have', 'do', 'does', 'watch', 'movie', 'movies', 'film', 'show', 'please',
  'another', 'one', 'some', 'what', 'like', 'tonight', 'feel', 'feeling', 'hello', 'hi', 'give', 'any',
  'that', 'this', 'thanks', 'yes', 'scary', 'cozy', 'rainy', 'evening', 'better', 'recommend',
]);

/**
 * Idioma de un mensaje, entre los dos de la interfaz, o `null` si no se sabe
 * («ok», «Interstellar»). Basta con esto porque solo hay que distinguir español
 * de inglés: se cuentan palabras que solo son de uno, y las tildes, eñes y
 * signos de apertura cuentan para el español.
 */
export function detectMessageLanguage(text: string): Locale | null {
  const lower = text.toLowerCase();
  let spanish = (lower.match(/[ñ¿¡áéíóú]/gu) ?? []).length;
  let english = 0;
  for (const word of lower.match(/[\p{L}']+/gu) ?? []) {
    if (SPANISH_WORDS.has(word)) spanish += 1;
    else if (ENGLISH_WORDS.has(word)) english += 1;
  }
  if (spanish === english) return null;
  return spanish > english ? 'es' : 'en';
}
