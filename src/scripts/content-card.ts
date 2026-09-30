/**
 * Ficha de contenido: cómo se describe un título y cómo se rellena en el
 * navegador a partir de la plantilla que pinta `ContentCard.astro`.
 *
 * `describeCard` lo usan el servidor y el navegador, para que la ficha diga lo
 * mismo se pinte donde se pinte. Nada de aquí importa código de servidor.
 */
import { CHAT_MODE_DEFINITIONS, type Recommendation } from '@/lib/types';

export interface CardDescription {
  readonly kind: string;
  readonly title: string;
  readonly year: string | null;
  /** Dirección en películas; creación en series, que es lo que guarda el corpus. */
  readonly credit: string | null;
  readonly genres: string | null;
  readonly posterAlt: string;
}

export function describeCard(item: Recommendation): CardDescription {
  return {
    kind: CHAT_MODE_DEFINITIONS[item.type].label,
    title: item.title,
    year: item.year === null ? null : String(item.year),
    credit:
      item.director === null
        ? null
        : `${item.type === 'movie' ? 'Dirección' : 'Creación'}: ${item.director}`,
    genres: item.genres.length > 0 ? item.genres.join(' · ') : null,
    posterAlt: `Cartel de ${item.title}`,
  };
}

function field<T extends HTMLElement>(card: HTMLElement, name: string): T | null {
  return card.querySelector<T>(`[data-field="${name}"]`);
}

function setText(card: HTMLElement, name: string, value: string | null): void {
  const element = field(card, name);
  if (element === null) return;
  element.textContent = value ?? '';
  element.hidden = value === null;
}

/** Rellena una ficha clonada de la plantilla. */
export function fillContentCard(card: HTMLElement, item: Recommendation, favorite: boolean): void {
  const description = describeCard(item);
  card.dataset.contentId = item.id;

  setText(card, 'kind', description.kind);
  setText(card, 'title', description.title);
  setText(card, 'year', description.year);
  setText(card, 'credit', description.credit);
  setText(card, 'genres', description.genres);

  const poster = field<HTMLImageElement>(card, 'poster');
  const noPoster = field(card, 'no-poster');
  if (poster !== null && item.poster_url !== null) {
    poster.src = item.poster_url;
    poster.alt = description.posterAlt;
    poster.hidden = false;
    if (noPoster !== null) noPoster.hidden = true;
  }

  // `null` es «TMDB no respondió»: mejor no decir nada que decir «en ninguna».
  const platformsBlock = field(card, 'platforms-block');
  const platformsList = field(card, 'platforms');
  const noPlatforms = field(card, 'no-platforms');
  if (platformsBlock !== null) platformsBlock.hidden = item.platforms === null;
  if (platformsList !== null && item.platforms !== null) {
    platformsList.replaceChildren(
      ...item.platforms.map((name) => {
        const li = document.createElement('li');
        li.textContent = name;
        return li;
      }),
    );
    platformsList.hidden = item.platforms.length === 0;
  }
  if (noPlatforms !== null) noPlatforms.hidden = item.platforms?.length !== 0;

  const button = card.querySelector<HTMLButtonElement>('[data-favorite-button]');
  if (button !== null) {
    button.dataset.contentId = item.id;
    button.setAttribute('aria-pressed', String(favorite));
  }
}

// ─── Favoritos ───────────────────────────────────────────────────────────────

/** Se emite en `document` cada vez que un favorito cambia y el servidor lo confirma. */
export const FAVORITE_EVENT = 'umber:favorite';

export interface FavoriteEventDetail {
  readonly contentId: string;
  readonly saved: boolean;
}

function buttonsFor(contentId: string): NodeListOf<HTMLButtonElement> {
  return document.querySelectorAll<HTMLButtonElement>(
    `[data-favorite-button][data-content-id="${CSS.escape(contentId)}"]`,
  );
}

function setStatus(button: HTMLButtonElement, message: string): void {
  const status = button.closest('[data-content-card]')?.querySelector('[data-field="favorite-status"]');
  if (status instanceof HTMLElement) {
    status.textContent = message;
    status.hidden = message.length === 0;
  }
}

async function toggleFavorite(button: HTMLButtonElement): Promise<void> {
  const contentId = button.dataset.contentId;
  if (contentId === undefined || contentId.length === 0 || button.dataset.pending === 'true') return;

  const saved = button.getAttribute('aria-pressed') !== 'true';
  // Optimista: el botón cambia ya y vuelve atrás si el servidor falla.
  const apply = (value: boolean): void => {
    buttonsFor(contentId).forEach((item) => {
      item.setAttribute('aria-pressed', String(value));
    });
  };

  apply(saved);
  setStatus(button, '');
  button.dataset.pending = 'true';
  try {
    const response = await fetch('/api/favorites', {
      method: saved ? 'POST' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_id: contentId }),
    });
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    document.dispatchEvent(
      new CustomEvent<FavoriteEventDetail>(FAVORITE_EVENT, { detail: { contentId, saved } }),
    );
  } catch {
    apply(!saved);
    setStatus(button, saved ? 'No se ha podido guardar. Prueba otra vez.' : 'No se ha podido quitar. Prueba otra vez.');
  } finally {
    delete button.dataset.pending;
  }
}

let initialized = false;

/**
 * Un solo listener para toda la página: vale también para las fichas que el
 * chat añade después de cargar.
 */
export function initFavoriteButtons(): void {
  if (initialized) return;
  initialized = true;
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('[data-favorite-button]');
    if (button !== null) void toggleFavorite(button);
  });
}
