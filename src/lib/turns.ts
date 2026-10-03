/**
 * El estado de una conversación con Umber, sacado del historial: cuántas
 * preguntas lleva, qué buscó la última vez y qué candidatos le quedan.
 *
 * Cómo conversa (decisión de producto, ver `docs/fase-4-api-chat.md`):
 *  1. Antes de buscar pregunta para entender el ánimo: al menos dos veces y como
 *     mucho cuatro. Si la persona se enrolla, cierra con una pregunta que lleve a
 *     buscar.
 *  2. Busca con un resumen del ánimo que escribe él (`buscar_titulos`).
 *  3. Si le piden otra, saca la siguiente de esos candidatos sin volver a
 *     buscar, hasta agotarlos. Cuando se acaban, o si el ánimo cambia, busca de
 *     nuevo.
 *
 * El mínimo y el máximo de preguntas los hace cumplir el servidor con
 * `tool_choice`: no depende de que el modelo los recuerde.
 */
import { UUID_PATTERN } from '@/lib/api';
import type { ToolChoice } from '@/lib/deepseek';
import type {
  AssistantTurnMeta,
  ChatHistoryMessage,
  SearchCandidateRef,
  TurnSearch,
} from '@/lib/types';

export const MIN_QUESTIONS = 2;
export const MAX_QUESTIONS = 4;
/** Un resumen del ánimo son una o dos frases; más es que el modelo se ha ido de madre. */
export const MAX_SUMMARY_CHARS = 500;
/** Los que se pasan al modelo en cada búsqueda: `DEFAULT_CANDIDATE_COUNT`. */
const MAX_CANDIDATES = 10;

// ─── Validación ──────────────────────────────────────────────────────────────

function isContentId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function parseCandidate(value: unknown): SearchCandidateRef | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, similarity } = value as Record<string, unknown>;
  return isContentId(id) && typeof similarity === 'number' && Number.isFinite(similarity)
    ? { id, similarity }
    : null;
}

function parseSearch(value: unknown): TurnSearch | null {
  if (typeof value !== 'object' || value === null) return null;
  const { summary, candidates } = value as Record<string, unknown>;
  if (typeof summary !== 'string' || summary.length === 0 || summary.length > MAX_SUMMARY_CHARS) {
    return null;
  }
  if (!Array.isArray(candidates) || candidates.length > MAX_CANDIDATES) return null;
  const parsed = candidates.map(parseCandidate);
  return parsed.every((item): item is SearchCandidateRef => item !== null)
    ? { summary, candidates: parsed }
    : null;
}

/**
 * Lo que recuerda un mensaje de Umber, venga de Supabase o del navegador. Lo mal
 * formado se descarta sin perder el mensaje: solo se pierde el estado de ese
 * turno. Un id del navegador que no es del corpus no llega a nada: los
 * candidatos se vuelven a leer de la base.
 */
export function parseTurnMeta(record: Readonly<Record<string, unknown>>): AssistantTurnMeta {
  const search = parseSearch(record['search']);
  const ids = record['recommendation_ids'];
  return {
    ...(search === null ? {} : { search }),
    ...(Array.isArray(ids) && ids.length <= MAX_CANDIDATES && ids.every(isContentId)
      ? { recommendation_ids: ids }
      : {}),
  };
}

// ─── Estado ──────────────────────────────────────────────────────────────────

export interface ConversationState {
  /** La última búsqueda, o `null` si aún no ha buscado. */
  readonly lastSearch: TurnSearch | null;
  /** Los candidatos de esa búsqueda que aún no ha recomendado, en su orden. */
  readonly remaining: readonly SearchCandidateRef[];
  readonly recommendedIds: ReadonlySet<string>;
  /** Respuestas seguidas de Umber, al final, sin buscar ni recomendar: sus preguntas. */
  readonly pendingQuestions: number;
}

function isQuestion(message: ChatHistoryMessage): boolean {
  return message.search === undefined && (message.recommendation_ids ?? []).length === 0;
}

export function conversationState(history: readonly ChatHistoryMessage[]): ConversationState {
  const assistant = history.filter((message) => message.role === 'assistant');
  const recommendedIds = new Set(assistant.flatMap((message) => message.recommendation_ids ?? []));
  const lastSearch = assistant.findLast((message) => message.search !== undefined)?.search ?? null;

  let pendingQuestions = 0;
  for (let index = assistant.length - 1; index >= 0; index -= 1) {
    const message = assistant[index];
    if (message === undefined || !isQuestion(message)) break;
    pendingQuestions += 1;
  }

  return {
    lastSearch,
    remaining: (lastSearch?.candidates ?? []).filter((candidate) => !recommendedIds.has(candidate.id)),
    recommendedIds,
    pendingQuestions,
  };
}

/**
 * Si Umber puede buscar en este turno. Antes de la primera búsqueda no puede
 * hasta haber preguntado `MIN_QUESTIONS` veces; con `MAX_QUESTIONS` preguntas
 * seguidas, está obligado.
 */
export function toolChoiceFor(state: ConversationState): ToolChoice {
  if (state.lastSearch === null && state.pendingQuestions < MIN_QUESTIONS) return 'none';
  if (state.pendingQuestions >= MAX_QUESTIONS) return 'required';
  return 'auto';
}
