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

/** Una herramienta que el modelo puede llamar, con sus parámetros en JSON Schema. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** JSON sin validar: lo interpreta quien la ejecuta. */
  readonly arguments: string;
}

/** Una llamada del modelo a una herramienta y lo que devolvió, para la segunda vuelta. */
export interface ToolRound {
  readonly call: ToolCall;
  readonly result: string;
}

/**
 * `none` impide llamar a herramientas, `required` obliga, `auto` lo decide el
 * modelo. Es como el servidor hace cumplir las reglas de la conversación sin
 * depender de que el modelo las recuerde.
 */
export type ToolChoice = 'auto' | 'none' | 'required';

export interface ChatRequestOptions {
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolDefinition[];
  /** Solo con `tools`. Por defecto `auto`. */
  readonly toolChoice?: ToolChoice;
  /** La llamada anterior del modelo a una herramienta y su resultado, que van al final. */
  readonly toolRound?: ToolRound;
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
  toolRound: ToolRound | undefined,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const sdk: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  if (toolRound !== undefined) {
    const { call, result } = toolRound;
    sdk.push(
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } },
        ],
      },
      { role: 'tool', tool_call_id: call.id, content: result },
    );
  }
  return sdk;
}

function toSdkTools(
  tools: readonly ToolDefinition[] | undefined,
): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
  return tools?.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: { ...tool.parameters } },
  }));
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
  const tools = toSdkTools(options.tools);
  const body: DeepSeekParams<OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming> = {
    model: DEEPSEEK_MODELS.chat,
    messages: toSdkMessages(options.messages, options.toolRound),
    temperature: options.temperature ?? DEEPSEEK_TEMPERATURE.chat,
    max_tokens: options.maxTokens ?? DEEPSEEK_MAX_TOKENS,
    stream: true,
    thinking: THINKING_DISABLED,
    ...(tools === undefined ? {} : { tools, tool_choice: options.toolChoice ?? 'auto' }),
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

export type TurnEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_call'; readonly call: ToolCall };

/**
 * Un stream ya abierto como eventos: el texto según llega y, al final, las
 * llamadas a herramientas. Los argumentos de una llamada llegan troceados en
 * varios fragmentos, identificados por su `index`: se juntan antes de emitirla.
 */
export async function* turnEvents(stream: ChunkStream): AsyncGenerator<TurnEvent> {
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  try {
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta === undefined) continue;
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        yield { type: 'text', text: delta.content };
      }
      for (const part of delta.tool_calls ?? []) {
        const call = calls.get(part.index) ?? { id: '', name: '', arguments: '' };
        if (part.id !== undefined) call.id = part.id;
        call.name += part.function?.name ?? '';
        call.arguments += part.function?.arguments ?? '';
        calls.set(part.index, call);
      }
    }
  } catch (error: unknown) {
    throw new DeepSeekError(`El stream de chat se cortó: ${toError(error).message}`, error);
  }
  for (const call of calls.values()) {
    if (call.name.length > 0) yield { type: 'tool_call', call };
  }
}

/**
 * Llamada sin streaming. Solo para tareas internas y deterministas (clasificar
 * el modo, extraer entidades del mensaje). Nunca para la respuesta al usuario.
 */
export async function complete(options: ChatRequestOptions): Promise<string> {
  const body: DeepSeekParams<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming> = {
    model: DEEPSEEK_MODELS.chat,
    messages: toSdkMessages(options.messages, options.toolRound),
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
