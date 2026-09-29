/**
 * Cliente de DeepSeek.
 *
 * La API de DeepSeek es compatible con el SDK de OpenAI, así que reutilizamos ese
 * SDK apuntando a `https://api.deepseek.com`.
 *
 * Los embeddings NO salen de aquí: DeepSeek no expone endpoint de embeddings.
 * Viven en `src/lib/embeddings.ts`, contra un modelo Qwen3 servido aparte.
 *
 * Reglas del proyecto:
 *  - El chat va SIEMPRE en streaming (mejor percepción de latencia).
 *  - Temperatura 0.8 para conversar, 0.1 para clasificar o extraer.
 *  - Máximo 600 tokens de respuesta.
 */
import OpenAI from 'openai';

import { env } from '@/lib/env';
import { DeepSeekError, toError } from '@/lib/errors';
import type { ChatMessage } from '@/lib/types';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

export const DEEPSEEK_MODELS = {
  /**
   * Conversación de Umber. `deepseek-flash` (DeepSeek-V4.1-Flash) es el modelo
   * estándar actual y el mejor calidad/precio para esta tarea: los candidatos
   * llegan ya seleccionados por la búsqueda vectorial, así que el modelo solo
   * tiene que elegir uno y redactar 600 tokens con voz propia.
   */
  chat: 'deepseek-flash',
} as const;

export const DEEPSEEK_TEMPERATURE = {
  /** Umber conversando: queremos voz propia, no un resumen plano. */
  chat: 0.8,
  /** Clasificación y extracción estructurada: casi determinista. */
  extraction: 0.1,
} as const;

export const DEEPSEEK_MAX_TOKENS = 600;

let client: OpenAI | undefined;

/** Cliente DeepSeek. Singleton perezoso: se crea en la primera petición. */
export function getDeepSeekClient(): OpenAI {
  client ??= new OpenAI({
    apiKey: env.deepseek.apiKey,
    baseURL: DEEPSEEK_BASE_URL,
  });
  return client;
}

export interface ChatRequestOptions {
  readonly messages: readonly ChatMessage[];
  /** Por defecto `DEEPSEEK_TEMPERATURE.chat`. */
  readonly temperature?: number;
  /** Por defecto `DEEPSEEK_MAX_TOKENS`. */
  readonly maxTokens?: number;
  /** Para cortar la generación si el cliente abandona la petición. */
  readonly signal?: AbortSignal;
}

type ChunkStream = AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

function toSdkMessages(
  messages: readonly ChatMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

/**
 * Llamada de chat en streaming. Devuelve los chunks crudos del SDK, por si el
 * endpoint necesita leer `usage` o `finish_reason`.
 */
export async function streamChat(options: ChatRequestOptions): Promise<ChunkStream> {
  try {
    return await getDeepSeekClient().chat.completions.create(
      {
        model: DEEPSEEK_MODELS.chat,
        messages: toSdkMessages(options.messages),
        temperature: options.temperature ?? DEEPSEEK_TEMPERATURE.chat,
        max_tokens: options.maxTokens ?? DEEPSEEK_MAX_TOKENS,
        stream: true,
      },
      options.signal === undefined ? undefined : { signal: options.signal },
    );
  } catch (error: unknown) {
    throw new DeepSeekError(`Fallo al abrir el stream de chat: ${toError(error).message}`, error);
  }
}

/**
 * Igual que `streamChat`, pero ya reducido a los fragmentos de texto. Es lo que
 * consume el endpoint del chat para enviar al navegador.
 */
export async function* streamChatText(options: ChatRequestOptions): AsyncGenerator<string> {
  const stream = await streamChat(options);
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta.content;
    if (delta !== undefined && delta !== null && delta.length > 0) {
      yield delta;
    }
  }
}

/**
 * Llamada sin streaming. Solo para tareas internas y deterministas (clasificar
 * el modo, extraer entidades del mensaje). Nunca para la respuesta al usuario.
 */
export async function complete(options: ChatRequestOptions): Promise<string> {
  try {
    const response = await getDeepSeekClient().chat.completions.create(
      {
        model: DEEPSEEK_MODELS.chat,
        messages: toSdkMessages(options.messages),
        temperature: options.temperature ?? DEEPSEEK_TEMPERATURE.extraction,
        max_tokens: options.maxTokens ?? DEEPSEEK_MAX_TOKENS,
        stream: false,
      },
      options.signal === undefined ? undefined : { signal: options.signal },
    );

    const content = response.choices[0]?.message.content;
    if (content === undefined || content === null) {
      throw new DeepSeekError('DeepSeek devolvió una respuesta sin contenido.');
    }
    return content;
  } catch (error: unknown) {
    if (error instanceof DeepSeekError) throw error;
    throw new DeepSeekError(`Fallo en la llamada a DeepSeek: ${toError(error).message}`, error);
  }
}
