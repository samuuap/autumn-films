/**
 * Piezas del chat que no dependen de HTTP: validar la petición, construir la
 * consulta y el contexto del modelo, y reconocer qué títulos ha recomendado.
 *
 * El endpoint `src/pages/api/chat.ts` solo las orquesta.
 */
import { UUID_PATTERN } from '@/lib/api';
import { ValidationError } from '@/lib/errors';
import { localeFromAcceptLanguage, regionFromAcceptLanguage } from '@/lib/locale';
import { lookupPlatforms } from '@/lib/platforms';
import { SYSTEM_PROMPT, renderUserContext } from '@/lib/prompts';
import type { RankedCandidate } from '@/lib/search';
import { posterUrl, TMDB_DEFAULT_REGION } from '@/lib/tmdb';
import {
  CHAT_MODE_DEFINITIONS,
  DEFAULT_LOCALE,
  MAX_HISTORY_MESSAGES,
  MAX_MESSAGE_CHARS,
  isChatMode,
  isLocale,
  type ChatMessage,
  type ChatMode,
  type ContentCandidate,
  type Locale,
  type Recommendation,
} from '@/lib/types';

// ─── Límites ─────────────────────────────────────────────────────────────────

/** Una respuesta de 600 tokens son unos 2.500 caracteres; el resto es margen. */
export const MAX_HISTORY_MESSAGE_CHARS = 4000;
/** Mensajes del historial que ve el modelo: los últimos seis turnos. */
export const HISTORY_WINDOW = 12;
/** Mensajes del usuario que forman la consulta de búsqueda, contando el actual. */
export const SEARCH_QUERY_TURNS = 3;
/** Longitud de la sinopsis de cada candidato en el prompt. */
const SYNOPSIS_MAX_CHARS = 400;

// ─── Validación ──────────────────────────────────────────────────────────────

export interface ChatRequest {
  readonly mode: ChatMode;
  readonly message: string;
  readonly history: readonly ChatMessage[];
  readonly conversationId: string | null;
  readonly locale: Locale;
  readonly region: string;
}

const REGION_PATTERN = /^[A-Z]{2}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Quita caracteres de control salvo saltos de línea y tabuladores, y recorta. */
function cleanText(text: string): string {
  return text.replace(/\r\n?/gu, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/gu, '').trim();
}

/** `field` en minúscula y con artículo («el mensaje»): va en mitad y al principio de frase. */
function parseText(value: unknown, maxChars: number, field: string): string {
  const subject = field.charAt(0).toUpperCase() + field.slice(1);
  if (typeof value !== 'string') {
    throw new ValidationError(`Falta ${field}.`);
  }
  const text = cleanText(value);
  if (text.length === 0) {
    throw new ValidationError(`${subject} está vacío.`);
  }
  if (text.length > maxChars) {
    throw new ValidationError(
      `${subject} es demasiado largo: ${String(text.length)} caracteres, el máximo es ${String(maxChars)}.`,
    );
  }
  return text;
}

function parseHistory(value: unknown): ChatMessage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ValidationError('El historial tiene que ser una lista de mensajes.');
  }
  if (value.length > MAX_HISTORY_MESSAGES) {
    throw new ValidationError(
      `El historial tiene ${String(value.length)} mensajes; el máximo es ${String(MAX_HISTORY_MESSAGES)}.`,
    );
  }
  return value.map((item: unknown) => {
    // `system` no: el cliente no puede escribir instrucciones al modelo.
    if (!isRecord(item) || (item['role'] !== 'user' && item['role'] !== 'assistant')) {
      throw new ValidationError('Cada mensaje del historial necesita un rol «user» o «assistant».');
    }
    return {
      role: item['role'],
      content: parseText(item['content'], MAX_HISTORY_MESSAGE_CHARS, 'un mensaje del historial'),
    };
  });
}

/** Valida el cuerpo de `POST /api/chat`. Todo lo que llega al modelo pasa por aquí. */
export function parseChatRequest(body: unknown, acceptLanguage: string | null): ChatRequest {
  if (!isRecord(body)) {
    throw new ValidationError('La petición tiene que ser un objeto JSON.');
  }

  const mode = body['mode'];
  if (!isChatMode(mode)) {
    throw new ValidationError('Modo desconocido.');
  }
  const definition = CHAT_MODE_DEFINITIONS[mode];
  if (!definition.available) {
    throw new ValidationError(`El modo «${definition.label}» todavía no está disponible.`);
  }

  const conversationId = body['conversation_id'];
  if (
    conversationId !== undefined &&
    (typeof conversationId !== 'string' || !UUID_PATTERN.test(conversationId))
  ) {
    throw new ValidationError('El identificador de conversación no es válido.');
  }

  const locale = body['locale'];
  if (locale !== undefined && !isLocale(locale)) {
    throw new ValidationError('Idioma no soportado.');
  }

  const region = body['region'];
  if (region !== undefined && (typeof region !== 'string' || !REGION_PATTERN.test(region))) {
    throw new ValidationError('La región tiene que ser un código de dos letras, como «ES».');
  }

  return {
    mode,
    message: parseText(body['message'], MAX_MESSAGE_CHARS, 'el mensaje'),
    history: parseHistory(body['history']),
    conversationId: conversationId ?? null,
    locale: locale ?? localeFromAcceptLanguage(acceptLanguage) ?? DEFAULT_LOCALE,
    region: region ?? regionFromAcceptLanguage(acceptLanguage) ?? TMDB_DEFAULT_REGION,
  };
}

// ─── Títulos mencionados ─────────────────────────────────────────────────────

/** Minúsculas, sin tildes ni puntuación: «¡Olvídate de mí!» y «olvidate de mi» son iguales. */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export interface TitleMention {
  readonly title: string;
  readonly year: number | null;
}

/**
 * Títulos en negrita de un texto de Umber, con el año que los sigue. `system.md`
 * le pide ese formato exacto: **Título** (año), solo para títulos.
 */
export function extractTitleMentions(text: string): TitleMention[] {
  return [...text.matchAll(/\*\*([^*\n]+?)\*\*(?:\s*\((\d{4})\))?/gu)].map((match) => ({
    title: (match[1] ?? '').trim(),
    year: match[2] === undefined ? null : Number(match[2]),
  }));
}

function mentionMatches(mention: TitleMention, candidate: ContentCandidate): boolean {
  return (
    normalizeTitle(mention.title) === normalizeTitle(candidate.title) &&
    (mention.year === null || candidate.year === null || mention.year === candidate.year)
  );
}

/** Lo que Umber ya ha recomendado en la conversación, sin repetir. */
export function extractRecommended(history: readonly ChatMessage[]): TitleMention[] {
  const seen = new Set<string>();
  const mentions: TitleMention[] = [];
  for (const message of history) {
    if (message.role !== 'assistant') continue;
    for (const mention of extractTitleMentions(message.content)) {
      const key = `${normalizeTitle(mention.title)}|${String(mention.year)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mentions.push(mention);
    }
  }
  return mentions;
}

export function isAlreadyRecommended(
  candidate: ContentCandidate,
  recommended: readonly TitleMention[],
): boolean {
  return recommended.some((mention) => mentionMatches(mention, candidate));
}

// ─── Búsqueda ────────────────────────────────────────────────────────────────

/**
 * Texto que se vectoriza: los últimos mensajes del usuario, no solo el actual.
 * «Dame otra» o «más alegre» no dicen nada solos; junto a «está lloviendo y
 * estoy melancólico» siguen buscando en el mismo ánimo.
 */
export function buildSearchQuery(history: readonly ChatMessage[], message: string): string {
  const previous = history
    .filter((item) => item.role === 'user')
    .slice(-(SEARCH_QUERY_TURNS - 1))
    .map((item) => item.content);
  return [...previous, message].join('\n');
}

// ─── Enriquecimiento con TMDB ────────────────────────────────────────────────

export interface EnrichedCandidate extends RankedCandidate {
  /** Suscripción o gratis en la región. `null` si TMDB no respondió a tiempo. */
  readonly platforms: readonly string[] | null;
}

export interface Enrichment {
  readonly candidates: EnrichedCandidate[];
  /** La caché de plataformas, escribiéndose. Nunca falla: ver `lookupPlatforms`. */
  readonly saved: Promise<void>;
}

/**
 * Añade las plataformas de cada candidato. TMDB es prescindible: si falla o
 * tarda, el candidato va sin plataformas y Umber no las menciona.
 */
export async function enrichCandidates(
  candidates: readonly RankedCandidate[],
  region: string,
  signal: AbortSignal,
): Promise<Enrichment> {
  const { platforms, saved } = await lookupPlatforms(candidates, region, signal);
  return {
    candidates: candidates.map((candidate, index) => ({
      ...candidate,
      platforms: platforms[index] ?? null,
    })),
    saved,
  };
}

// ─── Contexto del modelo ─────────────────────────────────────────────────────

function oneLine(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  if (flat.length <= maxChars) return flat;
  const cut = flat.slice(0, maxChars);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : maxChars)}…`;
}

function withYear(title: string, year: number | null): string {
  return year === null ? title : `${title} (${String(year)})`;
}

/** Formato de cada candidato tal como lo documenta `user-context.md`. */
function formatCandidate(candidate: EnrichedCandidate, index: number, region: string): string {
  const head = [withYear(candidate.title, candidate.year)];
  if (candidate.director !== null) head.push(`dir. ${candidate.director}`);
  head.push(candidate.type);
  if (candidate.genres !== null && candidate.genres.length > 0) {
    head.push(`géneros: ${candidate.genres.join(', ')}`);
  }

  const meta = [`similitud ${candidate.similarity.toFixed(2)}`];
  if (candidate.autumn_score !== null) meta.push(`otoño ${candidate.autumn_score.toFixed(2)}`);
  if (candidate.platforms !== null) {
    meta.push(
      `plataformas: ${candidate.platforms.length > 0 ? candidate.platforms.join(', ') : `ninguna de suscripción en ${region}`}`,
    );
  }

  const lines = [`- [${String(index + 1)}] ${head.join(' · ')}`, `      ${meta.join(' · ')}`];
  if (candidate.synopsis !== null) {
    lines.push(`      ${oneLine(candidate.synopsis, SYNOPSIS_MAX_CHARS)}`);
  }
  return lines.join('\n');
}

/**
 * El mensaje va citado línea a línea: así un «## Candidatos del corpus» escrito
 * por el usuario queda dentro de la cita y no se confunde con la estructura del
 * prompt, que es de donde el modelo saca los únicos títulos que puede recomendar.
 */
function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

export interface ChatContext {
  readonly request: ChatRequest;
  /** Historial completo, para saber qué se ha recomendado ya. */
  readonly history: readonly ChatMessage[];
  readonly candidates: readonly EnrichedCandidate[];
  readonly recommended: readonly TitleMention[];
}

/** Los últimos turnos, empezando siempre por un mensaje del usuario. */
function historyWindow(history: readonly ChatMessage[]): ChatMessage[] {
  const window = history.slice(-HISTORY_WINDOW);
  const firstUser = window.findIndex((message) => message.role === 'user');
  return firstUser === -1 ? [] : window.slice(firstUser);
}

/** system.md + historial reciente + la plantilla rellena como último mensaje. */
export function buildChatMessages(context: ChatContext): ChatMessage[] {
  const { request, candidates, recommended } = context;
  const definition = CHAT_MODE_DEFINITIONS[request.mode];

  const userContext = renderUserContext({
    mode: request.mode,
    mode_label: request.locale === 'en' ? definition.labelEn : definition.label,
    locale: request.locale,
    region: request.region,
    today: new Date().toISOString().slice(0, 10),
    user_message: quote(request.message),
    candidates:
      candidates.length === 0
        ? '(ninguno)'
        : candidates.map((candidate, index) => formatCandidate(candidate, index, request.region)).join('\n'),
    already_recommended:
      recommended.length === 0
        ? '(ninguno)'
        : recommended.map((mention) => `- ${withYear(mention.title, mention.year)}`).join('\n'),
  });

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    ...historyWindow(context.history),
    { role: 'user', content: userContext },
  ];
}

// ─── Recomendaciones ─────────────────────────────────────────────────────────

/**
 * Candidatos que Umber ha recomendado en `text`, en el orden en que aparecen. Es
 * lo que permite a la interfaz pintar la ficha sin tener que interpretar el texto.
 * El año desempata títulos repetidos, como *La niebla* película y serie.
 */
export function findRecommendations(
  text: string,
  candidates: readonly EnrichedCandidate[],
): Recommendation[] {
  const found: EnrichedCandidate[] = [];
  for (const mention of extractTitleMentions(text)) {
    const candidate = candidates.find((item) => mentionMatches(mention, item));
    if (candidate !== undefined && !found.includes(candidate)) found.push(candidate);
  }

  return found.map((candidate) => ({
    id: candidate.id,
    tmdb_id: candidate.tmdb_id,
    type: candidate.type,
    title: candidate.title,
    year: candidate.year,
    director: candidate.director,
    genres: candidate.genres ?? [],
    poster_url: posterUrl(candidate.poster_path),
    platforms: candidate.platforms,
  }));
}
