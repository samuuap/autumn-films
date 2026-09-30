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
 *  - Sin razonamiento: ver `THINKING_DISABLED`.
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

/**
 * `deepseek-flash` razona por defecto, y esos tokens cuentan contra `max_tokens`.
 * Medido con prompts y candidatos reales: razonando con 600 tokens, una de cada
 * tres respuestas llegó vacía; con 3.000, la primera palabra tardaba hasta 6,3 s
 * y la elección no mejoraba. Sin razonar llega en menos de un segundo. Los modos
 * `weekend` y `month` podrán activarlo, con más `max_tokens`, porque planificar
 * varios días sí se beneficia de pensar.
 */
const THINKING_DISABLED = { type: 'disabled' } as const;

/** `thinking` es propio de DeepSeek: el SDK de OpenAI no lo tipa, pero lo envía en el cuerpo. */
type DeepSeekParams<T> = T & { readonly thinking: typeof THINKING_DISABLED };

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

export type ChunkStream = AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

function toSdkMessages(
  messages: readonly ChatMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

/**
 * Llamada de chat en streaming. Devuelve los chunks crudos del SDK, por si el
 * endpoint necesita leer `usage` o `finish_reason`.
 *
 * La promesa se resuelve al llegar las cabeceras de la respuesta, así que los
 * errores del proveedor (clave, saldo, límite de peticiones) saltan aquí y no a
 * mitad del stream: el endpoint aún puede responder con un código HTTP.
 */
export async function streamChat(options: ChatRequestOptions): Promise<ChunkStream> {
  const body: DeepSeekParams<OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming> = {
    model: DEEPSEEK_MODELS.chat,
    messages: toSdkMessages(options.messages),
    temperature: options.temperature ?? DEEPSEEK_TEMPERATURE.chat,
    max_tokens: options.maxTokens ?? DEEPSEEK_MAX_TOKENS,
    stream: true,
    thinking: THINKING_DISABLED,
  };
  try {
    return await getDeepSeekClient().chat.completions.create(
      body,
      options.signal === undefined ? undefined : { signal: options.signal },
    );
  } catch (error: unknown) {
    throw new DeepSeekError(`Fallo al abrir el stream de chat: ${toError(error).message}`, error);
  }
}

/** Reduce un stream ya abierto a sus fragmentos de texto. */
export async function* textDeltas(stream: ChunkStream): AsyncGenerator<string> {
  try {
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta.content;
      if (delta !== undefined && delta !== null && delta.length > 0) {
        yield delta;
      }
    }
  } catch (error: unknown) {
    throw new DeepSeekError(`El stream de chat se cortó: ${toError(error).message}`, error);
  }
}

/**
 * Igual que `streamChat`, pero ya reducido a los fragmentos de texto. Abre la
 * conexión en la primera iteración: si hace falta que los errores del proveedor
 * lleguen antes de empezar a responder, usar `streamChat` + `textDeltas`.
 */
export async function* streamChatText(options: ChatRequestOptions): AsyncGenerator<string> {
  yield* textDeltas(await streamChat(options));
}

/**
 * Llamada sin streaming. Solo para tareas internas y deterministas (clasificar
 * el modo, extraer entidades del mensaje). Nunca para la respuesta al usuario.
 */
export async function complete(options: ChatRequestOptions): Promise<string> {
  const body: DeepSeekParams<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming> = {
    model: DEEPSEEK_MODELS.chat,
    messages: toSdkMessages(options.messages),
    temperature: options.temperature ?? DEEPSEEK_TEMPERATURE.extraction,
    max_tokens: options.maxTokens ?? DEEPSEEK_MAX_TOKENS,
    stream: false,
    thinking: THINKING_DISABLED,
  };
  try {
    const response = await getDeepSeekClient().chat.completions.create(
      body,
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
