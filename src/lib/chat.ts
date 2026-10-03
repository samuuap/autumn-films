/**
 * Piezas del chat que no dependen de HTTP: validar la petición, construir el
 * contexto del modelo y la herramienta con la que busca, y reconocer qué títulos
 * ha recomendado.
 *
 * Umber pregunta antes de buscar y busca él, con un resumen del ánimo: las
 * reglas y el estado de la conversación están en `src/lib/turns.ts`. El endpoint
 * `src/pages/api/chat.ts` solo lo orquesta.
 */
import { REGION_PATTERN, UUID_PATTERN, isRecord, parseText } from '@/lib/api';
import { ValidationError } from '@/lib/errors';
import {
  detectMessageLanguage,
  localeFromAcceptLanguage,
  regionFromAcceptLanguage,
} from '@/lib/locale';
import type { ToolDefinition } from '@/lib/deepseek';
import { lookupPlatforms, type PlatformsCache } from '@/lib/platforms';
import { SYSTEM_PROMPT, renderUserContext } from '@/lib/prompts';
import { normalizeTitle, type RankedCandidate } from '@/lib/search';
import { posterUrl, TMDB_DEFAULT_REGION } from '@/lib/tmdb';
import {
  MAX_QUESTIONS,
  MAX_SUMMARY_CHARS,
  MIN_QUESTIONS,
  parseTurnMeta,
  type ConversationState,
} from '@/lib/turns';
import {
  CHAT_MODE_DEFINITIONS,
  DEFAULT_LOCALE,
  MAX_CONVERSATION_MESSAGES,
  MAX_MESSAGE_CHARS,
  remainingTurns,
  isChatMode,
  isLocale,
  type ChatHistoryMessage,
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
/**
 * Mensajes del usuario con los que se busca si el resumen del modelo no sirve
 * (vacío o demasiado largo), contando el actual.
 */
export const SEARCH_QUERY_TURNS = 3;
/** Longitud de la sinopsis de cada candidato en el prompt. */
const SYNOPSIS_MAX_CHARS = 400;

// ─── Validación ──────────────────────────────────────────────────────────────

export interface ChatRequest {
  readonly mode: ChatMode;
  readonly message: string;
  readonly history: readonly ChatHistoryMessage[];
  readonly conversationId: string | null;
  readonly locale: Locale;
  readonly region: string;
}

function parseHistory(value: unknown): ChatHistoryMessage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ValidationError('El historial tiene que ser una lista de mensajes.');
  }
  // Uno lleno se rechaza después, con su propio error: ver `prepareChat`.
  if (value.length > MAX_CONVERSATION_MESSAGES) {
    throw new ValidationError(
      `El historial tiene ${String(value.length)} mensajes; el máximo es ${String(MAX_CONVERSATION_MESSAGES)}.`,
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
      // Lo que recuerda cada turno de Umber: sin ello no sabría qué candidatos le quedan.
      ...(item['role'] === 'assistant' ? parseTurnMeta(item) : {}),
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

/** Vale el título en español y el inglés: Umber escribe el del idioma en que responde. */
function mentionMatches(mention: TitleMention, candidate: ContentCandidate): boolean {
  const mentioned = normalizeTitle(mention.title);
  const titles = [candidate.title, candidate.title_en].flatMap((title) =>
    title === null ? [] : [normalizeTitle(title)],
  );
  return (
    titles.includes(mentioned) &&
    (mention.year === null || candidate.year === null || mention.year === candidate.year)
  );
}

/** Título en el idioma de la respuesta. El corpus siempre tiene el español; el inglés, casi siempre. */
function titleIn(candidate: ContentCandidate, language: Locale): string {
  return language === 'en' ? (candidate.title_en ?? candidate.title) : candidate.title;
}

/** Sinopsis en el idioma de la respuesta, o en el otro si falta: todo título tiene al menos una. */
function synopsisIn(candidate: ContentCandidate, language: Locale): string | null {
  return language === 'en'
    ? (candidate.synopsis_en ?? candidate.synopsis)
    : (candidate.synopsis ?? candidate.synopsis_en);
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
 * Respaldo del resumen del modelo: los últimos mensajes del usuario, no solo el
 * actual. «Dame otra» o «más alegre» no dicen nada solos; junto a «está
 * lloviendo y estoy melancólico» siguen en el mismo ánimo.
 */
export function buildSearchQuery(history: readonly ChatMessage[], message: string): string {
  const previous = history
    .filter((item) => item.role === 'user')
    .slice(-(SEARCH_QUERY_TURNS - 1))
    .map((item) => item.content);
  return [...previous, message].join('\n');
}

/** La herramienta con la que Umber busca, cuando ya tiene claro el ánimo. */
export const SEARCH_TOOL: ToolDefinition = {
  name: 'buscar_titulos',
  description:
    'Busca en el catálogo títulos que encajen con el ánimo de la persona. Llámala cuando ya lo tengas claro, o cuando necesites títulos nuevos porque su ánimo ha cambiado o ya no te quedan candidatos. Para un título concreto que nombre la persona, usa buscar_por_titulo.',
  parameters: {
    type: 'object',
    properties: {
      resumen: {
        type: 'string',
        description:
          'El ánimo y lo que le apetece ver, en una o dos frases en inglés (el catálogo está en inglés): tono, ritmo, temas, con quién lo ve. Conserva los títulos, personas o lugares que mencione. Lo que no quiere, dilo en positivo: en vez de «nada de terror», «something calm and gentle».',
      },
    },
    required: ['resumen'],
  },
};

/**
 * La herramienta con la que comprueba un título concreto. Está en todos los
 * turnos, también antes de poder buscar por ánimo: a «¿tienes El padrino?» no
 * hay que hacerle preguntas, y sin ella respondía que no lo tenía sin mirar.
 */
export const TITLE_SEARCH_TOOL: ToolDefinition = {
  name: 'buscar_por_titulo',
  description:
    'Comprueba si un título concreto está en el catálogo, en qué plataformas se puede ver, y trae otros parecidos. Llámala en cuanto la persona nombre un título: si lo pide, si pregunta si lo tienes, dónde verlo (o descargarlo) o si quiere algo parecido a él. Puedes usarla en cualquier momento de la conversación. Nunca la uses para buscar por ánimo.',
  parameters: {
    type: 'object',
    properties: {
      titulo: {
        type: 'string',
        description:
          'El título tal como lo nombra la persona y, si lo conoces, también su título en inglés, separados por « / ». Por ejemplo: «Cadena perpetua / The Shawshank Redemption».',
      },
    },
    required: ['titulo'],
  },
};

/** Títulos que se piden de una vez, como mucho: «Cadena perpetua / The Shawshank Redemption». */
const MAX_TITLE_VARIANTS = 4;

/**
 * Los títulos que pidió el modelo al llamar a `buscar_por_titulo`. Si no se
 * pueden leer, se busca con el mensaje de la persona tal cual.
 */
export function parseTitleQuery(args: string, fallback: string): string[] {
  try {
    const parsed: unknown = JSON.parse(args);
    const raw = isRecord(parsed) && typeof parsed['titulo'] === 'string' ? parsed['titulo'] : '';
    const titles = raw
      .split('/')
      .map((title) => title.trim())
      .filter((title) => title.length > 0 && title.length <= MAX_SUMMARY_CHARS)
      // «The Godfather / The Godfather»: cuando el título ya es el inglés, lo repite.
      .filter((title, index, all) => all.findIndex((other) => normalizeTitle(other) === normalizeTitle(title)) === index)
      .slice(0, MAX_TITLE_VARIANTS);
    if (titles.length > 0) return titles;
  } catch {
    // JSON roto: vale el respaldo.
  }
  return [fallback.slice(0, MAX_SUMMARY_CHARS)];
}

/**
 * El resumen que escribió el modelo al llamar a `buscar_titulos`. Si no se
 * puede leer, o viene vacío o desmesurado, se busca con los últimos mensajes de
 * la persona: una búsqueda peor es mejor que un error.
 */
export function parseSearchSummary(args: string, fallback: string): { summary: string; fromModel: boolean } {
  try {
    const parsed: unknown = JSON.parse(args);
    const summary = isRecord(parsed) && typeof parsed['resumen'] === 'string' ? parsed['resumen'].trim() : '';
    if (summary.length > 0 && summary.length <= MAX_SUMMARY_CHARS) return { summary, fromModel: true };
  } catch {
    // JSON roto: vale el respaldo.
  }
  return { summary: fallback.slice(0, MAX_SUMMARY_CHARS), fromModel: false };
}

// ─── Idioma de la respuesta ──────────────────────────────────────────────────

/**
 * El del mensaje; si no se sabe («ok», «Interstellar»), el de los mensajes
 * anteriores de la persona, y si tampoco, el de la interfaz.
 *
 * Se decide aquí y no se deja al modelo: con todo el contexto en español, a «Do
 * you have The Godfather?» respondía en español aunque la plantilla le pedía
 * contestar en el idioma del mensaje (2 de 2 mensajes en inglés, 2026-09-30).
 */
export function replyLanguage(
  message: string,
  history: readonly ChatMessage[],
  interfaceLocale: Locale,
): Locale {
  const earlier = history
    .filter((item) => item.role === 'user')
    .map((item) => item.content)
    .join('\n');
  return detectMessageLanguage(message) ?? detectMessageLanguage(earlier) ?? interfaceLocale;
}

const LANGUAGE_NAMES: Readonly<Record<Locale, string>> = {
  es: 'español',
  en: 'inglés (English)',
};

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
 * tarda, el candidato va sin plataformas y Umber no las menciona. `cache`, si
 * ya se pidió con `readPlatformsCache`.
 */
export async function enrichCandidates(
  candidates: readonly RankedCandidate[],
  region: string,
  signal: AbortSignal,
  cache?: Promise<PlatformsCache>,
): Promise<Enrichment> {
  const { platforms, saved } = await lookupPlatforms(candidates, region, signal, cache);
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

/**
 * Formato de cada candidato tal como lo documenta `user-context.md`. Título y
 * sinopsis van en el idioma de la respuesta: el modelo copia el título tal cual,
 * y así nombra *Always Be My Maybe* y no *Siempre queda el amor* a quien escribe
 * en inglés.
 */
function formatCandidate(
  candidate: EnrichedCandidate,
  index: number,
  region: string,
  language: Locale,
): string {
  const head = [withYear(titleIn(candidate, language), candidate.year)];
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
  const synopsis = synopsisIn(candidate, language);
  if (synopsis !== null) {
    lines.push(`      ${oneLine(synopsis, SYNOPSIS_MAX_CHARS)}`);
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
  readonly state: ConversationState;
  /** Los que le quedan de su última búsqueda, ya con plataformas; vacío si no ha buscado. */
  readonly candidates: readonly EnrichedCandidate[];
  readonly recommended: readonly TitleMention[];
  /** Idioma en que responde Umber: ver `replyLanguage`. */
  readonly language: Locale;
}

/**
 * En qué punto está la conversación, dicho al modelo. Lo que no puede hacer en
 * este turno ya se lo impide `tool_choice`; esto es para que lo entienda y no
 * lo intente.
 */
function describeState(state: ConversationState): string {
  const questions = `Llevas ${String(state.pendingQuestions)} de ${String(MAX_QUESTIONS)} preguntas seguidas.`;
  const titleOnly = 'Si nombra un título concreto, compruébalo con buscar_por_titulo.';
  if (state.lastSearch === null) {
    if (state.pendingQuestions === 0) {
      return `Aún no has buscado ni preguntado nada. En este turno no puedes buscar por ánimo: haz tu primera pregunta para entenderlo. ${titleOnly}`;
    }
    if (state.pendingQuestions < MIN_QUESTIONS) {
      return `Aún no has buscado. ${questions} En este turno no puedes buscar por ánimo: haz otra pregunta sobre algo que aún no sepas de lo que le apetece. ${titleOnly}`;
    }
    if (state.pendingQuestions >= MAX_QUESTIONS) {
      return `Aún no has buscado. ${questions} Ya no puedes preguntar más: busca ahora con buscar_titulos, con lo que sabes.`;
    }
    return `Aún no has buscado. ${questions} Si ya tienes claro su ánimo, busca con buscar_titulos; si no, haz otra pregunta.`;
  }
  const last = `Tu última búsqueda fue: «${state.lastSearch.summary}».`;
  if (state.pendingQuestions >= MAX_QUESTIONS) {
    return `${last} ${questions} Ya no puedes preguntar más: busca ahora con buscar_titulos, con su ánimo actualizado.`;
  }
  if (state.remaining.length === 0) {
    return `${last} Ya has recomendado todos sus candidatos: si quiere otra, o si su ánimo ha cambiado, busca de nuevo con buscar_titulos.`;
  }
  return `${last} Te quedan ${String(state.remaining.length)} candidatos de ella (abajo). Si pide otra, elige una de ellos sin buscar. Si su ánimo ha cambiado, busca de nuevo con buscar_titulos.`;
}

/**
 * Lo cerca que está el final de la conversación (`MAX_CONVERSATION_MESSAGES`),
 * para que cierre recomendando y no la deje a medias con una pregunta.
 */
function describeEnding(historyLength: number): string | null {
  const after = remainingTurns(historyLength + 2);
  if (after === 0) {
    return 'Este es tu último mensaje en esta conversación: no hagas preguntas. Si ya le has recomendado algo, despídete con calidez; si no, recomiéndale uno ahora.';
  }
  if (after <= 2) {
    return `A esta conversación solo le quedan ${String(after)} mensajes tuyos después de este: ve cerrando, sin abrir temas nuevos.`;
  }
  return null;
}

function formatCandidates(
  candidates: readonly EnrichedCandidate[],
  region: string,
  language: Locale,
): string {
  return candidates.map((candidate, index) => formatCandidate(candidate, index, region, language)).join('\n');
}

/**
 * Lo que devuelve `buscar_titulos` al modelo. Sustituye a los candidatos que le
 * quedaban: si ha buscado, es que esos ya no le valían.
 */
export function formatSearchResult(
  candidates: readonly EnrichedCandidate[],
  region: string,
  language: Locale,
): string {
  if (candidates.length === 0) {
    return 'Ningún título del catálogo encaja con esa búsqueda. Díselo con naturalidad y pregúntale por otro ángulo de su ánimo. No nombres ninguna película.';
  }
  return [
    'Candidatos del catálogo para esa búsqueda. Son los únicos que puedes recomendar ahora; los que te quedaban de antes ya no valen.',
    'Vienen ordenados por parecido y por cuán otoñales son, pero el orden no es una recomendación: elige el que de verdad encaje.',
    '',
    formatCandidates(candidates, region, language),
    '',
    `Recomienda uno solo, en ${LANGUAGE_NAMES[language]}, con el título tal como viene arriba.`,
  ].join('\n');
}

/**
 * Lo que devuelve `buscar_por_titulo` al modelo: si está lo que ha pedido, y
 * los parecidos para «otra» o para «algo como esta».
 */
export function formatTitleResult(
  exact: readonly EnrichedCandidate[],
  similar: readonly EnrichedCandidate[],
  region: string,
  language: Locale,
): string {
  if (exact.length === 0) {
    return 'Ese título no está en el catálogo. Díselo con naturalidad, sin nombrar ningún otro título, y sigue la conversación: si aún no sabes qué le apetece, pregúntale.';
  }
  const lines = [
    'Está en el catálogo. Lo que ha pedido:',
    '',
    formatCandidates(exact, region, language),
  ];
  if (similar.length > 0) {
    lines.push(
      '',
      'Otros parecidos, por si quiere algo como esa o pide otra. Junto con lo de arriba, son los únicos que puedes recomendar ahora:',
      '',
      similar
        .map((candidate, index) => formatCandidate(candidate, exact.length + index, region, language))
        .join('\n'),
    );
  }
  lines.push(
    '',
    `Si lo ha pedido, recomiéndaselo; si quería algo parecido, elige uno de los parecidos. Uno solo, en ${LANGUAGE_NAMES[language]}, con el título tal como viene arriba.`,
  );
  return lines.join('\n');
}

/**
 * Los últimos turnos, empezando siempre por un mensaje del usuario. Al modelo
 * solo le llegan rol y texto: los mensajes guardados llevan además fecha, ids y
 * idioma.
 */
function historyWindow(history: readonly ChatMessage[]): ChatMessage[] {
  const window = history.slice(-HISTORY_WINDOW);
  const firstUser = window.findIndex((message) => message.role === 'user');
  return firstUser === -1 ? [] : window.slice(firstUser).map(({ role, content }) => ({ role, content }));
}

/** system.md + historial reciente + la plantilla rellena como último mensaje. */
export function buildChatMessages(context: ChatContext): ChatMessage[] {
  const { request, state, candidates, recommended, language } = context;
  const definition = CHAT_MODE_DEFINITIONS[request.mode];

  const userContext = renderUserContext({
    mode: request.mode,
    mode_label: request.locale === 'en' ? definition.labelEn : definition.label,
    reply_language: LANGUAGE_NAMES[language],
    region: request.region,
    today: new Date().toISOString().slice(0, 10),
    user_message: quote(request.message),
    conversation_state: [describeState(state), describeEnding(context.history.length)]
      .filter((part) => part !== null)
      .join(' '),
    candidates:
      state.lastSearch === null
        ? '(aún no has buscado)'
        : candidates.length === 0
          ? '(no te queda ninguno)'
          : formatCandidates(candidates, request.region, language),
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
  language: Locale,
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
    title: titleIn(candidate, language),
    year: candidate.year,
    director: candidate.director,
    genres: candidate.genres ?? [],
    poster_url: posterUrl(candidate.poster_path),
    platforms: candidate.platforms,
  }));
}
