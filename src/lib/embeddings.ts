/**
 * Generación de embeddings con Qwen3-Embedding-0.6B.
 *
 * DeepSeek no expone endpoint de embeddings. Se habla con el servicio por la API
 * de embeddings de OpenAI, que exponen Cloudflare Workers AI (producción), el
 * servidor local de `npm run embeddings`, Text Embeddings Inference y vLLM:
 * cambiar de uno a otro es cambiar `EMBEDDINGS_URL`, `EMBEDDINGS_API_KEY` y
 * `EMBEDDINGS_MODEL`. Antes, `scripts/seed/check-embeddings.py` comprueba que
 * el nuevo da los mismos vectores que indexaron el corpus.
 *
 * Las consultas se vectorizan aquí; el corpus, en `scripts/seed/embed.py`. La
 * normalización y la instrucción están duplicadas en `scripts/seed/common.py` y
 * tienen que coincidir. Cambiar de modelo o de dimensión obliga a reindexar el
 * corpus completo.
 */
import OpenAI from 'openai';

import { env } from '@/lib/env';
import { EmbeddingError, ValidationError, toError } from '@/lib/errors';

/**
 * El modelo que indexó el corpus. Cada servicio lo llama a su manera
 * (`@cf/qwen/qwen3-embedding-0.6b` en Cloudflare): el nombre que se pide va en
 * `EMBEDDINGS_MODEL`, y por defecto es este.
 */
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
 *
 * No dice «autumnal» a propósito: todo el corpus ya es otoñal, así que la
 * palabra no filtraba nada y arrastraba hacia títulos con «otoño» en el nombre
 * (14 de 120 resultados en 12 consultas de control; con esta, 0). También separa
 * mejor los mensajes ajenos al cine. Medidas en `docs/fase-4-api-chat.md`.
 */
export const EMBEDDING_TASK =
  'Given a description of how a viewer feels or what they feel like watching, retrieve a film or series whose tone and story match that mood';

let client: OpenAI | undefined;

function getEmbeddingsClient(): OpenAI {
  client ??= new OpenAI({
    baseURL: env.embeddings.url,
    // En local no hay autenticación, pero el SDK exige un valor no vacío.
    apiKey: env.embeddings.apiKey ?? 'local',
    // En Cloudflare, una consulta tarda 1,2 s de mediana, pero con picos: en una
    // hora, el 10 % pasó de 5,8 s y la más lenta llegó a 11,7 s (sin ningún
    // error). 15 s deja pasar los picos. El SDK espera por defecto 10 minutos y
    // reintenta dos veces: con el servicio colgado, el chat se quedaría mudo en
    // vez de decir que el buscador no responde.
    timeout: 15_000,
    maxRetries: 1,
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
      model: env.embeddings.model,
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
 * Vectoriza el mensaje del usuario para buscar en el corpus, con la instrucción
 * de tarea. El corpus se vectoriza sin ella, en `scripts/seed/embed.py`.
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
 * Serializa un vector al literal de pgvector (`"[0.1,0.2,...]"`), que es lo que
 * espera PostgREST al insertar o al pasar el vector a `search_content`.
 */
export function toPgVector(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}
