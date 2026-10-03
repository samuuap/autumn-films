/**
 * Lectura y escritura de `conversations`.
 *
 * Siempre con el cliente del usuario, nunca con la secret key: que sea RLS quien
 * garantice que nadie lee ni escribe conversaciones ajenas.
 */
import { isRecord } from '@/lib/api';
import { NotFoundError, SupabaseError } from '@/lib/errors';
import { unwrap, type UmberSupabaseClient } from '@/lib/supabase';
import { parseTurnMeta } from '@/lib/turns';
import { isChatMode, isLocale, type ChatMode, type StoredChatMessage } from '@/lib/types';

export interface StoredConversation {
  readonly id: string;
  readonly mode: ChatMode;
  readonly messages: readonly StoredChatMessage[];
}

/**
 * Un mensaje, o `null` si le falta lo imprescindible. Los campos opcionales mal
 * formados se descartan sin perder el mensaje: sin ellos solo faltan las fichas
 * o el estado de ese turno.
 */
function parseMessage(value: unknown): StoredChatMessage | null {
  if (!isRecord(value)) return null;
  const { role, content, created_at: createdAt, language } = value;
  if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || typeof createdAt !== 'string') {
    return null;
  }
  return {
    role,
    content,
    created_at: createdAt,
    ...(role === 'assistant' ? parseTurnMeta(value) : {}),
    ...(isLocale(language) ? { language } : {}),
  };
}

/** `messages` es JSONB: se valida al leer en vez de confiar en su forma. */
function parseMessages(value: unknown): StoredChatMessage[] {
  return Array.isArray(value)
    ? value.flatMap((item: unknown) => {
        const message = parseMessage(item);
        return message === null ? [] : [message];
      })
    : [];
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

/** Borra una conversación. Una ajena o que ya no existe no da error: RLS no la ve y no borra nada. */
export async function deleteConversation(client: UmberSupabaseClient, id: string): Promise<void> {
  const { error } = await client.from('conversations').delete().eq('id', id);
  if (error !== null) throw new SupabaseError(error.message, error);
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
  return messages.map(({ role, content, created_at, recommendation_ids: ids, search, language }) => ({
    role,
    content,
    created_at,
    ...(ids === undefined ? {} : { recommendation_ids: [...ids] }),
    ...(search === undefined
      ? {}
      : {
          search: {
            summary: search.summary,
            candidates: search.candidates.map(({ id, similarity }) => ({ id, similarity })),
          },
        }),
    ...(language === undefined ? {} : { language }),
  }));
}

/**
 * Añade mensajes a una conversación, o la crea con ese `id`.
 *
 * El append lo hace `append_conversation_messages` en un solo UPDATE, sin leer
 * antes el array: dos peticiones a la vez sobre la misma conversación guardan
 * los dos turnos. Reescribirlo desde aquí perdía uno.
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

  const appended = unwrap(
    await client.rpc('append_conversation_messages', {
      p_id: options.id,
      p_messages: toJson(options.messages),
    }),
  );
  // RLS no da error con una fila ajena: la función no actualiza nada y devuelve false.
  if (!appended) {
    throw new NotFoundError('La conversación ya no existe.');
  }
}
