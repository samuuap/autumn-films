/**
 * POST /api/chat — Umber responde en streaming (Server-Sent Events).
 *
 * Validar → rate limit → historial (de Supabase o del cliente) → estado de la
 * conversación → DeepSeek con la herramienta `buscar_titulos` → responder.
 *
 * Umber pregunta antes de buscar y busca él, con un resumen del ánimo (reglas
 * en `src/lib/turns.ts`). En cada turno hace una de tres cosas:
 *  - preguntar: la respuesta es texto y no se busca nada;
 *  - buscar: llama a la herramienta; se vectoriza su resumen, se buscan y
 *    enriquecen los candidatos, y una segunda llamada escribe la recomendación;
 *  - recomendar «otra» de los candidatos que le quedan, que se vuelven a leer
 *    de la base sin vectorizar.
 *
 * La búsqueda ocurre ya con el stream abierto, detrás de un evento `searching`
 * para que la persona sepa qué está esperando: un fallo del buscador llega como
 * evento `error`. Lo de antes de DeepSeek (validar, rate limit, historial) sigue
 * fallando con su código HTTP. Los eventos están tipados en `ChatStreamEvent`.
 */
import type { APIContext, APIRoute } from 'astro';

import { publicError, readClientAddress, readJson } from '@/lib/api';
import { getRequestUser, type RequestUser } from '@/lib/auth';
import {
  SEARCH_TOOL,
  TITLE_SEARCH_TOOL,
  buildChatMessages,
  buildSearchQuery,
  enrichCandidates,
  extractRecommended,
  extractTitleMentions,
  findRecommendations,
  formatSearchResult,
  formatTitleResult,
  isAlreadyRecommended,
  parseChatRequest,
  parseSearchSummary,
  parseTitleQuery,
  replyLanguage,
  type ChatRequest,
  type EnrichedCandidate,
} from '@/lib/chat';
import {
  loadConversation,
  saveConversationTurn,
  type StoredConversation,
} from '@/lib/conversations';
import {
  streamChat,
  turnEvents,
  type ChatRequestOptions,
  type ToolCall,
  type TurnEvent,
} from '@/lib/deepseek';
import { AuthError, ConversationFullError, DeepSeekError, ValidationError } from '@/lib/errors';
import { readPlatformsCache } from '@/lib/platforms';
import { enforceRateLimit } from '@/lib/rate-limit';
import {
  DEFAULT_CANDIDATE_COUNT,
  loadCandidates,
  searchCandidates,
  searchTitles,
  toCandidateRefs,
  type RankedCandidate,
} from '@/lib/search';
import { MAX_SUMMARY_CHARS, conversationState, turnToolsFor } from '@/lib/turns';
import {
  CHAT_MODE_DEFINITIONS,
  MAX_CONVERSATION_MESSAGES,
  type ContentCandidate,
  type ChatHistoryMessage,
  type ChatStreamEvent,
  type Locale,
  type Recommendation,
  type StoredChatMessage,
  type TurnSearch,
} from '@/lib/types';

// ─── Preparación ─────────────────────────────────────────────────────────────

/** Lo que el turno va sabiendo mientras se escribe la respuesta. */
interface TurnOutcome {
  /** Entre los que puede haber recomendado: los que le quedaban, o los de la búsqueda nueva. */
  candidates: readonly EnrichedCandidate[];
  /** La búsqueda de este turno, si la hubo. */
  search: TurnSearch | null;
}

interface PreparedChat {
  readonly request: ChatRequest;
  readonly user: RequestUser | null;
  /** La conversación guardada que se continúa, o `null` si es nueva. */
  readonly conversation: StoredConversation | null;
  /** Historial anterior al mensaje actual. */
  readonly history: readonly ChatHistoryMessage[];
  /** Idioma de la respuesta: el de las fichas tiene que ser el mismo. */
  readonly language: Locale;
  /** La respuesta de Umber según llega. La primera llamada a DeepSeek ya está abierta. */
  readonly parts: AsyncIterable<ReplyPart>;
  readonly outcome: TurnOutcome;
}

/** Un fragmento del texto de Umber, o el aviso de que empieza a buscar. */
type ReplyPart = { readonly type: 'text'; readonly text: string } | { readonly type: 'searching' };

/** La conversación que se continúa, o `null` si es nueva. */
async function loadRequestedConversation(
  chat: ChatRequest,
  user: RequestUser | null,
): Promise<StoredConversation | null> {
  if (chat.conversationId === null || user === null) return null;
  const conversation = await loadConversation(user.client, chat.conversationId);
  if (conversation.mode !== chat.mode) {
    throw new ValidationError('Esa conversación es de otro modo.');
  }
  return conversation;
}

/** Solo el texto de un stream: en la segunda llamada, con `tool_choice: none`, no hay más. */
async function* textOf(events: AsyncIterable<TurnEvent>): AsyncGenerator<ReplyPart> {
  for await (const event of events) {
    if (event.type === 'text') yield { type: 'text', text: event.text };
  }
}

/**
 * Caracteres que se retienen al principio de una respuesta. Antes de buscar,
 * Umber a veces escribe un preámbulo («Déjame ver qué tengo») y después llama a
 * la herramienta: en 4 de 6 búsquedas de prueba. Retenido, si detrás llega la
 * búsqueda se descarta, y la persona solo lee la recomendación. Los preámbulos
 * medidos no pasaban de 200 caracteres; una pregunta cabe entera, y una
 * recomendación se empieza a enviar en cuanto pasa de aquí.
 */
const PREAMBLE_HOLD_CHARS = 280;

/**
 * El texto de una respuesta que empezó escribiendo. Si llama a la herramienta
 * mientras lo retenido no pasa de `PREAMBLE_HOLD_CHARS`, era un preámbulo y se
 * descarta. Si ya se había enviado, se queda, y la recomendación va detrás.
 */
async function* continueText(
  first: string,
  rest: AsyncIterator<TurnEvent>,
  onSearch: (call: ToolCall) => AsyncIterable<ReplyPart>,
): AsyncGenerator<ReplyPart> {
  let held = first;
  let flushed = false;
  for (;;) {
    const next = await rest.next();
    if (next.done === true) {
      if (!flushed) yield { type: 'text', text: held };
      return;
    }
    if (next.value.type === 'text') {
      if (flushed) {
        yield { type: 'text', text: next.value.text };
      } else {
        held += next.value.text;
        if (held.length >= PREAMBLE_HOLD_CHARS) {
          yield { type: 'text', text: held };
          flushed = true;
        }
      }
    } else {
      if (flushed) yield { type: 'text', text: '\n\n' };
      yield* onSearch(next.value.call);
      return;
    }
  }
}

async function prepareChat(context: APIContext, signal: AbortSignal): Promise<PreparedChat> {
  const { request, locals } = context;
  const chat = parseChatRequest(await readJson(request), request.headers.get('accept-language'));
  const user = await getRequestUser({ request, locals });
  if (chat.conversationId !== null && user === null) {
    throw new AuthError('Para seguir una conversación guardada hay que iniciar sesión.');
  }

  // El límite va antes de cualquier llamada que cueste (embeddings, TMDB y
  // DeepSeek). Leer la conversación no cuesta, así que va a la vez: son dos
  // viajes a Supabase de unos 120 ms cada uno, medidos desde local.
  const [, conversation] = await Promise.all([
    enforceRateLimit('chat', { userId: user?.id ?? null, clientAddress: readClientAddress(context) }),
    loadRequestedConversation(chat, user),
  ]);

  // Con conversación guardada manda Supabase; sin ella, lo que el cliente tiene en memoria.
  const history = conversation?.messages ?? chat.history;
  // El turno añade dos mensajes: el de la persona y la respuesta.
  if (history.length + 2 > MAX_CONVERSATION_MESSAGES) {
    throw new ConversationFullError(
      user === null
        ? 'Aquí termina la conversación de prueba. Crea una cuenta gratis para seguir hablando con Umber.'
        : 'Esta conversación ha llegado a su final. Empieza una nueva para seguir hablando con Umber.',
    );
  }
  const state = conversationState(history);
  const recommended = extractRecommended(history);
  const language = replyLanguage(chat.message, history, chat.locale);

  // Los que le quedan de la última búsqueda, para «otra»: de la base, sin
  // vectorizar. Su caché de plataformas solo necesita los ids: se lee a la vez.
  const cache = readPlatformsCache(
    state.remaining.map((ref) => ref.id),
    signal,
  );
  const remaining = await enrichCandidates(await loadCandidates(state.remaining), chat.region, signal, cache);
  const outcome: TurnOutcome = { candidates: remaining.candidates, search: null };
  const tools = turnToolsFor(state);
  const base: ChatRequestOptions = {
    messages: buildChatMessages({
      request: chat,
      history,
      state,
      candidates: remaining.candidates,
      recommended,
      language,
    }),
    tools: tools.moodSearch ? [SEARCH_TOOL, TITLE_SEARCH_TOOL] : [TITLE_SEARCH_TOOL],
    signal,
  };
  const searchOptions = {
    contentType: CHAT_MODE_DEFINITIONS[chat.mode].contentType,
    exclude: (candidate: ContentCandidate) =>
      state.recommendedIds.has(candidate.id) || isAlreadyRecommended(candidate, recommended),
  };

  /**
   * Avisa de que busca, ejecuta la herramienta y escribe la recomendación con
   * una segunda llamada. Embedding, base y TMDB tardan varios segundos.
   */
  async function* runSearch(call: ToolCall): AsyncGenerator<ReplyPart> {
    yield { type: 'searching' };
    let found: RankedCandidate[];
    /** Lo que se recuerda de la búsqueda, o `null` si no cuenta como tal. */
    let summary: string | null;
    let describe: (candidates: readonly EnrichedCandidate[]) => string;

    if (call.name === TITLE_SEARCH_TOOL.name) {
      const titles = parseTitleQuery(call.arguments, chat.message);
      const { exact, similar } = await searchTitles(titles, searchOptions);
      const exactCount = Math.min(exact.length, DEFAULT_CANDIDATE_COUNT);
      found = exactCount === 0 ? [] : [...exact, ...similar].slice(0, DEFAULT_CANDIDATE_COUNT);
      // Un título que no está no es una búsqueda: no le ahorra preguntas.
      summary = exactCount === 0 ? null : `Título: ${titles.join(' / ')}`.slice(0, MAX_SUMMARY_CHARS);
      describe = (candidates) =>
        formatTitleResult(candidates.slice(0, exactCount), candidates.slice(exactCount), chat.region, language);
    } else {
      summary = parseSearchSummary(call.arguments, buildSearchQuery(history, chat.message)).summary;
      found = await searchCandidates(summary, searchOptions);
      describe = (candidates) => formatSearchResult(candidates, chat.region, language);
    }

    const enriched = await enrichCandidates(found, chat.region, signal);
    if (summary !== null) {
      outcome.candidates = enriched.candidates;
      outcome.search = { summary, candidates: toCandidateRefs(found) };
    }
    // La caché de plataformas se escribe mientras DeepSeek abre el stream: no retrasa nada.
    const [stream] = await Promise.all([
      streamChat({
        ...base,
        toolChoice: 'none',
        toolRound: { call, result: describe(enriched.candidates) },
      }),
      enriched.saved,
    ]);
    yield* textOf(turnEvents(stream));
  }

  const [stream] = await Promise.all([
    streamChat({ ...base, toolChoice: tools.choice }),
    remaining.saved,
  ]);
  // Lo primero que hace se mira antes de responder: un stream vacío de DeepSeek
  // todavía llega con su código HTTP.
  const events = turnEvents(stream)[Symbol.asyncIterator]();
  const head = await events.next();
  if (head.done === true) throw new DeepSeekError('DeepSeek cerró el stream sin texto.');
  const parts =
    head.value.type === 'tool_call'
      ? runSearch(head.value.call)
      : continueText(head.value.text, events, runSearch);

  return { request: chat, user, conversation, history, language, parts, outcome };
}

// ─── Guardado ────────────────────────────────────────────────────────────────

/**
 * Guarda el turno si hay sesión. Devuelve el id de la conversación, o `null`.
 * La respuesta va con lo que recuerda el turno: la búsqueda, si la hubo, para
 * sacar «otra» sin volver a buscar; los ids de lo recomendado, para no
 * repetirlos y para que `/chat` vuelva a pintar sus fichas; y el idioma.
 */
async function persist(
  prepared: PreparedChat,
  reply: string,
  recommendations: readonly Recommendation[],
): Promise<string | null> {
  const { user, request, conversation } = prepared;
  if (user === null) return null;

  const now = new Date().toISOString();
  // En una conversación nueva va también lo que el cliente traía en memoria:
  // quien inicia sesión a mitad de charla no pierde lo hablado.
  const earlier: StoredChatMessage[] =
    conversation === null
      ? prepared.history.map((message) => ({ ...message, created_at: now }))
      : [];
  const id = conversation?.id ?? crypto.randomUUID();

  try {
    await saveConversationTurn(user.client, {
      id,
      userId: user.id,
      mode: request.mode,
      existing: conversation,
      messages: [
        ...earlier,
        { role: 'user', content: request.message, created_at: now },
        {
          role: 'assistant',
          content: reply,
          created_at: now,
          recommendation_ids: recommendations.map((item) => item.id),
          ...(prepared.outcome.search === null ? {} : { search: prepared.outcome.search }),
          language: prepared.language,
        },
      ],
    });
    return id;
  } catch (error: unknown) {
    // La persona ya ha leído la respuesta: no se convierte en error, se registra.
    console.error('[api/chat] No se pudo guardar la conversación:', error);
    return null;
  }
}

// ─── Stream ──────────────────────────────────────────────────────────────────

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  // Que ningún proxy intermedio acumule el stream antes de reenviarlo.
  'X-Accel-Buffering': 'no',
} as const;

const encoder = new TextEncoder();

function encodeEvent(event: ChatStreamEvent): Uint8Array {
  return encoder.encode(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

function streamReply(prepared: PreparedChat, abort: AbortController): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let reply = '';
      try {
        for await (const part of prepared.parts) {
          if (part.type === 'searching') {
            controller.enqueue(encodeEvent({ event: 'searching', data: {} }));
            continue;
          }
          reply += part.text;
          controller.enqueue(encodeEvent({ event: 'delta', data: { text: part.text } }));
        }
        if (reply.trim().length === 0) {
          throw new DeepSeekError('DeepSeek cerró el stream sin texto.');
        }

        const { candidates, search } = prepared.outcome;
        const recommendations = findRecommendations(reply, candidates, prepared.language);
        // Un título en negrita que no sale de ninguna búsqueda es uno inventado.
        // Ya se ha escrito: al menos, que se vea en el log.
        const unknown = extractTitleMentions(reply).length - recommendations.length;
        if (unknown > 0) {
          console.warn(`[api/chat] Umber nombró ${String(unknown)} título(s) que no venían de una búsqueda.`);
        }
        const conversationId = await persist(prepared, reply, recommendations);
        controller.enqueue(
          encodeEvent({
            event: 'done',
            data: { conversation_id: conversationId, recommendations, search },
          }),
        );
      } catch (error: unknown) {
        // Si el cliente se ha ido no hay a quién avisar, ni una respuesta entera que guardar.
        if (abort.signal.aborted) return;
        console.error('[api/chat] Fallo durante el stream:', error);
        controller.enqueue(encodeEvent({ event: 'error', data: publicError(error).body.error }));
      } finally {
        try {
          controller.close();
        } catch {
          // Ya cerrado: el cliente canceló la lectura.
        }
      }
    },
    // El cliente deja de leer: se corta la generación para no pagar tokens que nadie lee.
    cancel() {
      abort.abort();
    },
  });
}

// ─── Endpoint ────────────────────────────────────────────────────────────────

export const POST: APIRoute = async (context) => {
  const abort = new AbortController();
  context.request.signal.addEventListener('abort', () => {
    abort.abort();
  });

  let prepared: PreparedChat;
  try {
    prepared = await prepareChat(context, abort.signal);
  } catch (error: unknown) {
    const { status, body, headers } = publicError(error);
    // Si el cliente se fue mientras se preparaba, el fallo es la propia cancelación.
    if (status >= 500 && !abort.signal.aborted) console.error('[api/chat]', error);
    return Response.json(body, { status, headers });
  }

  return new Response(streamReply(prepared, abort), { headers: SSE_HEADERS });
};
