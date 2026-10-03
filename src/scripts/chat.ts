/**
 * El chat en el navegador: manda el mensaje a `POST /api/chat`, pinta el stream
 * según llega y, al terminar, las fichas de lo recomendado.
 *
 * Sin framework (decisión de la Fase 5): una pantalla, poco estado. Sin sesión,
 * el historial vive solo en memoria y viaja en cada petición; con sesión, manda
 * la conversación guardada y aquí solo se recuerda su id.
 */
import { isApiErrorBody, readChatEvents } from '@/lib/chat-stream';
import { renderReply } from '@/lib/markdown';
import {
  FAVORITE_EVENT,
  fillContentCard,
  initFavoriteButtons,
  type FavoriteEventDetail,
} from '@/scripts/content-card';
import {
  CONVERSATION_WARNING_TURNS,
  isChatMode,
  remainingTurns,
  type ChatHistoryMessage,
  type ChatMode,
  type ChatRequestBody,
  type Recommendation,
} from '@/lib/types';

// ─── Elementos ───────────────────────────────────────────────────────────────

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (element === null) throw new Error(`Falta ${selector} en la página del chat.`);
  return element;
}

const root = required<HTMLElement>(document, '[data-chat]');
const list = required<HTMLOListElement>(root, '[data-messages]');
const form = required<HTMLFormElement>(root, '[data-composer]');
const input = required<HTMLTextAreaElement>(form, 'textarea');
const sendButton = required<HTMLButtonElement>(form, '[data-send]');
const stopButton = required<HTMLButtonElement>(form, '[data-stop]');
const turnsLeftNotice = required<HTMLElement>(form, '[data-turns-left]');
const conversationEnd = required<HTMLElement>(root, '[data-conversation-end]');
const emptyState = root.querySelector<HTMLElement>('[data-empty-state]');
const templates = {
  user: required<HTMLTemplateElement>(root, 'template[data-template="user"]'),
  assistant: required<HTMLTemplateElement>(root, 'template[data-template="assistant"]'),
  card: required<HTMLTemplateElement>(root, 'template[data-template="card"]'),
};

const modeAttribute = root.dataset.mode;
if (!isChatMode(modeAttribute)) {
  throw new Error(`Modo desconocido en la página del chat: ${String(modeAttribute)}`);
}
const mode: ChatMode = modeAttribute;

// ─── Estado ──────────────────────────────────────────────────────────────────

/** Id de la conversación guardada. Solo existe con sesión. */
let conversationId: string | null = root.dataset.conversationId || null;
/**
 * Turnos completos de esta visita. Sin sesión es todo el historial que hay, y
 * los de Umber llevan lo que devolvió `done`: el servidor lo necesita para saber
 * cuántas preguntas lleva y qué candidatos le quedan.
 */
const pastMessages: ChatHistoryMessage[] = [];
/** Los que ya traía la página: los de una conversación guardada. */
const initialMessageCount = Number(root.dataset.messageCount ?? '0');
const favorites = new Set<string>(JSON.parse(root.dataset.favorites ?? '[]') as string[]);
let controller: AbortController | null = null;

// La ficha de esta página vive en un `<template>`, y el `<script>` de
// `ContentCard.astro` queda dentro, inerte: los botones se activan desde aquí.
initFavoriteButtons();

document.addEventListener(FAVORITE_EVENT, (event) => {
  const { contentId, saved } = (event as CustomEvent<FavoriteEventDetail>).detail;
  if (saved) favorites.add(contentId);
  else favorites.delete(contentId);
});

// ─── Pintar ──────────────────────────────────────────────────────────────────

function clone(template: HTMLTemplateElement): HTMLElement {
  const fragment = template.content.cloneNode(true) as DocumentFragment;
  return required<HTMLElement>(fragment, 'li, article');
}

function part<T extends HTMLElement = HTMLElement>(bubble: HTMLElement, name: string): T {
  return required<T>(bubble, `[data-field="${name}"]`);
}

function isNearBottom(): boolean {
  return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
}

/**
 * Aplica un cambio y, si la persona estaba al final, la mantiene al final. Si
 * ha subido a leer, no se le mueve la pantalla.
 */
function keepPinned<T>(update: () => T): T {
  const pinned = isNearBottom();
  const result = update();
  if (pinned) window.scrollTo({ top: document.documentElement.scrollHeight });
  return result;
}

function appendUserMessage(text: string): void {
  const bubble = clone(templates.user);
  part(bubble, 'body').textContent = text;
  list.append(bubble);
}

function appendAssistantMessage(): HTMLElement {
  const bubble = clone(templates.assistant);
  list.append(bubble);
  return bubble;
}

const THINKING = 'Pensando…';
const SEARCHING = 'Buscando títulos que encajen…';

function resetAssistantMessage(bubble: HTMLElement): void {
  const status = part(bubble, 'status');
  status.textContent = THINKING;
  status.hidden = false;
  part(bubble, 'body').replaceChildren();
  part(bubble, 'error').hidden = true;
  part(bubble, 'cards').replaceChildren();
}

/** Sin `retry`, no se ofrece reintentar: repetir daría el mismo error. */
function showError(bubble: HTMLElement, message: string, retry: (() => void) | null): void {
  part(bubble, 'status').hidden = true;
  part(bubble, 'error-message').textContent = message;
  part(bubble, 'error').hidden = false;
  const retryButton = required<HTMLButtonElement>(bubble, '[data-retry]');
  retryButton.hidden = retry === null;
  retryButton.onclick = retry;
}

// ─── Final de la conversación ────────────────────────────────────────────────

/** Errores con los que el servidor dice que aquí ya no caben más mensajes. */
const END_CODES: ReadonlySet<string> = new Set(['conversation_full', 'trial_used']);

/** Cierra la conversación: fuera el cuadro de texto, y el panel para empezar otra o registrarse. */
function endConversation(): void {
  form.hidden = true;
  conversationEnd.hidden = false;
}

/** Avisa de los mensajes que quedan cuando son pocos, y cierra al llegar a cero. */
function updateTurnsLeft(): void {
  const turns = remainingTurns(initialMessageCount + pastMessages.length);
  if (turns === 0) {
    endConversation();
    return;
  }
  turnsLeftNotice.hidden = turns > CONVERSATION_WARNING_TURNS;
  turnsLeftNotice.textContent =
    turns === 1
      ? 'Te queda 1 mensaje en esta conversación.'
      : `Te quedan ${String(turns)} mensajes en esta conversación.`;
}

/** Animación de entrada; el CSS está en `global.css`. */
function revealCard(card: HTMLElement, index: number): void {
  card.style.setProperty('--reveal-delay', `${String(index * 150)}ms`);
  card.classList.add('reveal-card');
  const poster = card.querySelector<HTMLImageElement>('[data-field="poster"]');
  if (poster === null || poster.hidden) return;
  // Sin esperar a la carga, el revelado pasaría sobre un hueco vacío.
  poster.dataset.develop = 'waiting';
  const develop = (): void => {
    poster.dataset.develop = 'on';
  };
  poster.addEventListener('load', develop, { once: true });
  poster.addEventListener('error', develop, { once: true });
}

function renderCards(bubble: HTMLElement, recommendations: readonly Recommendation[]): void {
  part(bubble, 'cards').replaceChildren(
    ...recommendations.map((recommendation, index) => {
      const card = clone(templates.card);
      fillContentCard(card, recommendation, favorites.has(recommendation.id));
      revealCard(card, index);
      return card;
    }),
  );
}

function setBusy(busy: boolean): void {
  sendButton.disabled = busy;
  stopButton.hidden = !busy;
  list.setAttribute('aria-busy', String(busy));
}

// ─── Enviar ──────────────────────────────────────────────────────────────────

const NETWORK_ERROR = 'No hay conexión con Umber. Revisa tu red y vuelve a intentarlo.';
const CUT_ERROR = 'La respuesta se ha cortado a medias. Vuelve a intentarlo.';

async function readError(response: Response): Promise<{ code: string | null; message: string }> {
  try {
    const body: unknown = await response.json();
    if (isApiErrorBody(body)) return body.error;
  } catch {
    // Sin cuerpo JSON: vale el mensaje genérico.
  }
  return { code: null, message: 'Algo ha fallado por nuestra parte. Vuelve a intentarlo en un momento.' };
}

function requestBody(message: string): ChatRequestBody {
  // Con conversación guardada, el servidor lee el historial de Supabase.
  return conversationId === null
    ? { mode, message, history: pastMessages }
    : { mode, message, conversation_id: conversationId };
}

/**
 * Envía un mensaje. Con `bubble`, es un reintento: se reutiliza la respuesta
 * fallida y no se repite el mensaje del usuario en pantalla.
 */
async function send(message: string, bubble?: HTMLElement): Promise<void> {
  if (controller !== null) return;
  if (emptyState !== null) emptyState.hidden = true;

  const target =
    bubble ??
    keepPinned(() => {
      appendUserMessage(message);
      return appendAssistantMessage();
    });
  resetAssistantMessage(target);
  const retry = (): void => {
    void send(message, target);
  };

  const current = new AbortController();
  controller = current;
  setBusy(true);

  const status = part(target, 'status');
  const body = part(target, 'body');
  let text = '';
  let finished = false;

  /*
   * Como mucho un repintado por fotograma: cada uno rehace el HTML de toda la
   * respuesta y mide la página para seguir abajo, y los fragmentos llegan más
   * deprisa de lo que se ven. `flush` pinta ya lo pendiente, antes de las fichas
   * o de un error.
   */
  let frame: number | null = null;
  const paint = (): void => {
    frame = null;
    keepPinned(() => {
      status.hidden = true;
      body.innerHTML = renderReply(text);
    });
  };
  const flush = (): void => {
    if (frame === null) return;
    cancelAnimationFrame(frame);
    paint();
  };

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody(message)),
      signal: current.signal,
    });
    const isStream = response.headers.get('content-type')?.startsWith('text/event-stream') === true;
    if (!response.ok || !isStream || response.body === null) {
      const error = await readError(response);
      const ended = error.code !== null && END_CODES.has(error.code);
      showError(target, error.message, ended ? null : retry);
      if (ended) endConversation();
      return;
    }

    for await (const event of readChatEvents(response.body)) {
      if (event.event === 'delta') {
        text += event.data.text;
        frame ??= requestAnimationFrame(paint);
      } else if (event.event === 'searching') {
        status.textContent = SEARCHING;
      } else if (event.event === 'done') {
        flush();
        finished = true;
        pastMessages.push(
          { role: 'user', content: message },
          {
            role: 'assistant',
            content: text,
            recommendation_ids: event.data.recommendations.map((item) => item.id),
            ...(event.data.search === null ? {} : { search: event.data.search }),
          },
        );
        if (event.data.conversation_id !== null) {
          conversationId = event.data.conversation_id;
          // Recargar la página vuelve a esta conversación en vez de empezar otra.
          window.history.replaceState(null, '', `/chat?conversation=${conversationId}`);
        }
        keepPinned(() => {
          renderCards(target, event.data.recommendations);
        });
        updateTurnsLeft();
      } else {
        flush();
        finished = true;
        const ended = END_CODES.has(event.data.code);
        showError(target, event.data.message, ended ? null : retry);
        if (ended) endConversation();
      }
    }
    if (!finished) {
      flush();
      showError(target, CUT_ERROR, retry);
    }
  } catch {
    flush();
    if (current.signal.aborted) {
      showError(target, 'Has detenido la respuesta.', retry);
    } else {
      showError(target, NETWORK_ERROR, retry);
    }
  } finally {
    controller = null;
    setBusy(false);
  }
}

// ─── Eventos ─────────────────────────────────────────────────────────────────

/** El cuadro crece con el texto hasta el `max-height` del CSS. */
function fitInput(): void {
  input.style.height = 'auto';
  input.style.height = `${String(input.scrollHeight)}px`;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (message.length === 0 || controller !== null) return;
  input.value = '';
  fitInput();
  void send(message);
});

input.addEventListener('input', fitInput);

input.addEventListener('keydown', (event) => {
  // Intro envía; con Mayúsculas, salto de línea. `isComposing`: no cortar un acento a medias.
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});

stopButton.addEventListener('click', () => {
  controller?.abort();
});

/*
 * Sin sesión, la charla solo vive en memoria: ir a «Entrar» la perdería. Si ya
 * hay algo hablado, el enlace se abre en otra pestaña, como el de las fichas;
 * tras entrar allí, el siguiente mensaje de esta ya va con sesión y el servidor
 * guarda también lo anterior. Vale para el de la cabecera y para cualquier otro.
 */
document.addEventListener('click', (event) => {
  if (conversationId !== null || pastMessages.length === 0) return;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href^="/entrar"]') : null;
  if (link === null || link.target === '_blank') return;
  event.preventDefault();
  window.open(link.href, '_blank', 'noopener');
});

root.querySelectorAll<HTMLButtonElement>('[data-suggestion]').forEach((button) => {
  button.addEventListener('click', () => {
    const text = button.textContent?.trim() ?? '';
    if (text.length > 0) void send(text);
  });
});

// En una conversación guardada, abrir la página lleva al último mensaje.
if (list.children.length > 0) window.scrollTo({ top: document.documentElement.scrollHeight });
updateTurnsLeft();
