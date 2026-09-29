/**
 * Generación de embeddings con Qwen3-Embedding servido localmente.
 *
 * DeepSeek no expone endpoint de embeddings, así que la vectorización va contra
 * un servidor propio. Se habla con él por la API de embeddings de OpenAI, que es
 * la que exponen tanto Text Embeddings Inference como vLLM: cambiar de local a un
 * endpoint gestionado es cambiar `EMBEDDINGS_URL`, nada más.
 *
 * Levantar el modelo en local: `npm run embeddings` (ver README).
 *
 * Las consultas se vectorizan aquí; el corpus, en `scripts/seed/embed.py`. La
 * normalización y la instrucción están duplicadas en `scripts/seed/common.py` y
 * tienen que coincidir. Cambiar de modelo o de dimensión obliga a reindexar el
 * corpus completo.
 */
import OpenAI from 'openai';

import { env } from '@/lib/env';
import { EmbeddingError, ValidationError, toError } from '@/lib/errors';

export const EMBEDDING_MODEL = 'Qwen/Qwen3-Embedding-0.6B';

/**
 * Dimensión nativa de Qwen3-Embedding-0.6B. El modelo soporta MRL (32–1024),
 * pero usamos la nativa por calidad. Debe coincidir con `VECTOR(1024)`.
 */
export const EMBEDDING_DIMENSIONS = 1024;

/** El modelo acepta 32k tokens; recortamos muy por debajo por seguridad. */
export const EMBEDDING_MAX_CHARS = 8000;

/**
 * Qwen3-Embedding es asimétrico: la consulta lleva una instrucción de tarea y el
 * documento va en crudo. Omitirla cuesta entre un 1% y un 5% de precisión de
 * recuperación según el propio modelo. La instrucción va en inglés aunque el
 * corpus esté en español: es como está entrenado el modelo.
 */
export const EMBEDDING_TASK =
  'Given a description of how a viewer feels, retrieve the autumnal film or series that best matches that mood';

let client: OpenAI | undefined;

function getEmbeddingsClient(): OpenAI {
  client ??= new OpenAI({
    baseURL: env.embeddings.url,
    // En local no hay autenticación, pero el SDK exige un valor no vacío.
    apiKey: env.embeddings.apiKey ?? 'local',
  });
  return client;
}

/** Colapsa espacios, recorta y trunca. Misma normalización en corpus y consulta. */
export function normalizeForEmbedding(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().slice(0, EMBEDDING_MAX_CHARS);
}

/** Envuelve la consulta en el formato de instrucción que espera Qwen3. */
export function formatQuery(text: string): string {
  return `Instruct: ${EMBEDDING_TASK}\nQuery:${text}`;
}

function assertDimensions(vector: readonly number[]): void {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new EmbeddingError(
      `El embedding tiene ${String(vector.length)} dimensiones y el esquema espera ${String(EMBEDDING_DIMENSIONS)}. ` +
        `Comprueba que ${env.embeddings.url} sirve ${EMBEDDING_MODEL}.`,
    );
  }
}

async function embed(inputs: readonly string[]): Promise<number[][]> {
  if (inputs.length === 0) {
    throw new ValidationError('No hay textos que vectorizar.');
  }
  if (inputs.some((text) => text.length === 0)) {
    throw new ValidationError('No se puede vectorizar un texto vacío.');
  }

  try {
    const response = await getEmbeddingsClient().embeddings.create({
      model: EMBEDDING_MODEL,
      input: [...inputs],
    });

    // El servidor no garantiza el orden de salida: ordenamos por `index`.
    const vectors = [...response.data]
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);

    vectors.forEach(assertDimensions);
    return vectors;
  } catch (error: unknown) {
    if (error instanceof EmbeddingError || error instanceof ValidationError) throw error;
    throw new EmbeddingError(
      `Fallo al generar embeddings contra ${env.embeddings.url}: ${toError(error).message}`,
      error,
    );
  }
}

/**
 * Vectoriza el mensaje del usuario para buscar en el corpus. Aplica la
 * instrucción de tarea: usar esta función, no `embedDocuments`, en el chat.
 */
export async function embedQuery(text: string): Promise<number[]> {
  const normalized = normalizeForEmbedding(text);
  const [vector] = await embed([formatQuery(normalized)]);
  if (vector === undefined) {
    throw new EmbeddingError('El servicio de embeddings no devolvió ningún vector.');
  }
  return vector;
}

/**
 * Vectoriza textos del corpus (sinopsis + keywords), sin instrucción. Lo usan
 * los scripts de seed y cualquier indexado posterior.
 */
export async function embedDocuments(texts: readonly string[]): Promise<number[][]> {
  return embed(texts.map(normalizeForEmbedding));
}

/**
 * Serializa un vector al literal de pgvector (`"[0.1,0.2,...]"`), que es lo que
 * espera PostgREST al insertar o al pasar el vector a `search_content`.
 */
export function toPgVector(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}
