/**
 * Lectura y escritura de `conversations`.
 *
 * Siempre con el cliente del usuario, nunca con la secret key: que sea RLS quien
 * garantice que nadie lee ni escribe conversaciones ajenas.
 */
import { NotFoundError, SupabaseError } from '@/lib/errors';
import { unwrap, type UmberSupabaseClient } from '@/lib/supabase';
import { isChatMode, type ChatMode, type StoredChatMessage } from '@/lib/types';

export interface StoredConversation {
  readonly id: string;
  readonly mode: ChatMode;
  readonly messages: readonly StoredChatMessage[];
}

function isStoredChatMessage(value: unknown): value is StoredChatMessage {
  if (typeof value !== 'object' || value === null) return false;
  const { role, content, created_at: createdAt } = value as Record<string, unknown>;
  return (
    (role === 'user' || role === 'assistant') &&
    typeof content === 'string' &&
    typeof createdAt === 'string'
  );
}

/** `messages` es JSONB: se valida al leer en vez de confiar en su forma. */
function parseMessages(value: unknown): StoredChatMessage[] {
  return Array.isArray(value) ? value.filter(isStoredChatMessage) : [];
}

/** Lanza `NotFoundError` si no existe o es de otro usuario: RLS no distingue entre las dos. */
export async function loadConversation(
  client: UmberSupabaseClient,
  id: string,
): Promise<StoredConversation> {
  const { data, error } = await client
    .from('conversations')
    .select('id, mode, messages')
    .eq('id', id)
    .maybeSingle();
  if (error !== null) throw new SupabaseError(error.message, error);
  if (data === null) throw new NotFoundError('Esa conversación no existe.');
  if (!isChatMode(data.mode)) {
    throw new SupabaseError(`La conversación ${id} tiene un modo desconocido: ${data.mode}.`);
  }
  return { id: data.id, mode: data.mode, messages: parseMessages(data.messages) };
}

export interface ConversationSummary {
  readonly id: string;
  readonly mode: ChatMode;
  /** Primer mensaje del usuario: es lo que identifica la conversación en una lista. */
  readonly firstMessage: string | null;
  readonly updatedAt: string;
}

export const CONVERSATION_LIST_LIMIT = 50;

/** Conversaciones del usuario, la más reciente primero, sin cargar los mensajes enteros. */
export async function listConversations(
  client: UmberSupabaseClient,
): Promise<ConversationSummary[]> {
  const rows = unwrap(
    await client
      .from('conversations')
      .select('id, mode, updated_at, first_message:messages->0->>content')
      .order('updated_at', { ascending: false })
      .limit(CONVERSATION_LIST_LIMIT),
  );

  return rows.flatMap((row) =>
    isChatMode(row.mode)
      ? [
          {
            id: row.id,
            mode: row.mode,
            firstMessage: typeof row.first_message === 'string' ? row.first_message : null,
            updatedAt: row.updated_at,
          },
        ]
      : [],
  );
}

export interface SaveTurnOptions {
  readonly id: string;
  readonly userId: string;
  readonly mode: ChatMode;
  /** La conversación tal como se leyó, o `null` si es nueva. */
  readonly existing: StoredConversation | null;
  /** Mensajes que se añaden al final. */
  readonly messages: readonly StoredChatMessage[];
}

/** El tipo `Json` del generador no acepta interfaces: hacen falta objetos literales. */
function toJson(messages: readonly StoredChatMessage[]) {
  return messages.map(({ role, content, created_at }) => ({ role, content, created_at }));
}

/**
 * Añade mensajes a una conversación, o la crea con ese `id`.
 *
 * Lee, concatena y reescribe el array entero: dos peticiones simultáneas sobre la
 * misma conversación pueden perder un turno. Con una pestaña por conversación no
 * pasa; si llega a importar, la salida es una función SQL que haga el append.
 */
export async function saveConversationTurn(
  client: UmberSupabaseClient,
  options: SaveTurnOptions,
): Promise<void> {
  if (options.existing === null) {
    unwrap(
      await client
        .from('conversations')
        .insert({
          id: options.id,
          user_id: options.userId,
          mode: options.mode,
          messages: toJson(options.messages),
        })
        .select('id'),
    );
    return;
  }

  const updated = unwrap(
    await client
      .from('conversations')
      .update({
        messages: toJson([...options.existing.messages, ...options.messages]),
        updated_at: new Date().toISOString(),
      })
      .eq('id', options.id)
      .select('id'),
  );
  // RLS no da error al filtrar una fila ajena: la actualización afecta a 0.
  if (updated.length === 0) {
    throw new NotFoundError('La conversación ya no existe.');
  }
}
