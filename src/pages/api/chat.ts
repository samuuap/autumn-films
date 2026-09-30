/**
 * POST /api/chat — Umber responde en streaming (Server-Sent Events).
 *
 * Validar → rate limit → historial (de Supabase o del cliente) → buscar
 * candidatos → TMDB → abrir el stream de DeepSeek → responder. Todo lo que
 * puede fallar antes del primer token falla antes de devolver la respuesta,
 * para que llegue con su código HTTP. Los eventos del stream están tipados en
 * `ChatStreamEvent`.
 */
import type { APIContext, APIRoute } from 'astro';

import { publicError, readJson } from '@/lib/api';
import { getRequestUser, type RequestUser } from '@/lib/auth';
import {
  buildChatMessages,
  buildSearchQuery,
  enrichCandidates,
  extractRecommended,
  findRecommendations,
  isAlreadyRecommended,
  parseChatRequest,
  type ChatRequest,
  type EnrichedCandidate,
} from '@/lib/chat';
import {
  loadConversation,
  saveConversationTurn,
  type StoredConversation,
} from '@/lib/conversations';
import { streamChat, textDeltas, type ChunkStream } from '@/lib/deepseek';
import { AuthError, DeepSeekError, ValidationError } from '@/lib/errors';
import { enforceChatRateLimit } from '@/lib/rate-limit';
import { searchCandidates } from '@/lib/search';
import {
  CHAT_MODE_DEFINITIONS,
  type ChatMessage,
  type ChatStreamEvent,
  type StoredChatMessage,
} from '@/lib/types';

// ─── Preparación ─────────────────────────────────────────────────────────────

interface PreparedChat {
  readonly request: ChatRequest;
  readonly user: RequestUser | null;
  /** La conversación guardada que se continúa, o `null` si es nueva. */
  readonly conversation: StoredConversation | null;
  /** Historial anterior al mensaje actual. */
  readonly history: readonly ChatMessage[];
  readonly candidates: readonly EnrichedCandidate[];
  /** Ya abierto: si DeepSeek iba a rechazar la petición, ya lo ha hecho. */
  readonly stream: ChunkStream;
}

/** Astro lanza si el adaptador no conoce la IP. En Vercel y en `astro dev` la conoce. */
function readClientAddress(context: APIContext): string | null {
  try {
    return context.clientAddress;
  } catch {
    console.warn('[api/chat] Petición sin IP: cuenta en el cupo compartido «ip:unknown».');
    return null;
  }
}

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
    enforceChatRateLimit({ userId: user?.id ?? null, clientAddress: readClientAddress(context) }),
    loadRequestedConversation(chat, user),
  ]);

  // Con conversación guardada manda Supabase; sin ella, lo que el cliente tiene en memoria.
  const history = conversation?.messages ?? chat.history;
  const recommended = extractRecommended(history);

  const found = await searchCandidates(buildSearchQuery(history, chat.message), {
    contentType: CHAT_MODE_DEFINITIONS[chat.mode].contentType,
    exclude: (candidate) => isAlreadyRecommended(candidate, recommended),
  });
  const { candidates, saved } = await enrichCandidates(found, chat.region, signal);

  // La caché de plataformas se escribe mientras DeepSeek abre el stream: no retrasa nada.
  const [stream] = await Promise.all([
    streamChat({
      messages: buildChatMessages({ request: chat, history, candidates, recommended }),
      signal,
    }),
    saved,
  ]);

  return { request: chat, user, conversation, history, candidates, stream };
}

// ─── Guardado ────────────────────────────────────────────────────────────────

/** Guarda el turno si hay sesión. Devuelve el id de la conversación, o `null`. */
async function persist(prepared: PreparedChat, reply: string): Promise<string | null> {
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
        { role: 'assistant', content: reply, created_at: now },
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
        for await (const text of textDeltas(prepared.stream)) {
          reply += text;
          controller.enqueue(encodeEvent({ event: 'delta', data: { text } }));
        }
        if (reply.trim().length === 0) {
          throw new DeepSeekError('DeepSeek cerró el stream sin texto.');
        }

        const conversationId = await persist(prepared, reply);
        controller.enqueue(
          encodeEvent({
            event: 'done',
            data: {
              conversation_id: conversationId,
              recommendations: findRecommendations(reply, prepared.candidates),
            },
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
