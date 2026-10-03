/**
 * Lectura del stream SSE de `POST /api/chat` en el navegador.
 *
 * `EventSource` solo hace GET, así que el cuerpo se lee a mano con `fetch`. No
 * importa nada de servidor: lo bundlea el `<script>` de la página del chat.
 */
import type { ApiErrorBody, ChatStreamEvent } from '@/lib/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    isRecord(value) &&
    isRecord(value['error']) &&
    typeof value['error']['code'] === 'string' &&
    typeof value['error']['message'] === 'string'
  );
}

/** Un bloque SSE (`event: …\ndata: …`) a evento tipado. Ignora lo que no conoce. */
function parseBlock(block: string): ChatStreamEvent | null {
  let name = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(data.join('\n'));
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  if (name === 'delta' || name === 'searching' || name === 'done' || name === 'error') {
    // La forma de cada evento la garantiza el endpoint, tipado con el mismo `ChatStreamEvent`.
    return { event: name, data: payload } as ChatStreamEvent;
  }
  return null;
}

/**
 * Eventos del stream según llegan. Un fragmento de red puede cortar un evento
 * por la mitad: se acumula hasta la línea en blanco que lo cierra.
 */
export async function* readChatEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatStreamEvent> {
  const reader = body.getReader();
  // `stream: true` guarda los bytes de un carácter partido entre dos fragmentos.
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const event = parseBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (event !== null) yield event;
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}
