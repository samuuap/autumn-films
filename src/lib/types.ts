/**
 * Tipos de dominio de Umber.
 *
 * Los tipos de fila de la base de datos viven en `database.types.ts`; aquí están
 * los que usa la aplicación (modos, mensajes, candidatos enriquecidos).
 */
import type { Database, SearchContentRow } from '@/lib/database.types';

// ─── Contenido ───────────────────────────────────────────────────────────────

export type ContentType = 'movie' | 'tv';
export type ContentStatus = 'released' | 'ended' | 'ongoing';

/** Fila completa de la tabla `content`. */
export type Content = Database['public']['Tables']['content']['Row'];
export type ContentInsert = Database['public']['Tables']['content']['Insert'];

/** Candidato devuelto por la búsqueda semántica, con su score de similitud. */
export type ContentCandidate = SearchContentRow;

export type Conversation = Database['public']['Tables']['conversations']['Row'];
export type Favorite = Database['public']['Tables']['users_favorites']['Row'];

// ─── Modos ───────────────────────────────────────────────────────────────────

/**
 * Los 4 modos de la app. `weekend` y `month` están diseñados pero no
 * implementados (v2): no eliminar sus constantes ni sus tipos.
 */
export const CHAT_MODES = ['movie', 'tv', 'weekend', 'month'] as const;

export type ChatMode = (typeof CHAT_MODES)[number];

export interface ChatModeDefinition {
  readonly id: ChatMode;
  readonly label: string;
  readonly labelEn: string;
  readonly description: string;
  /** Tipo de contenido al que se restringe la búsqueda, o null si no aplica. */
  readonly contentType: ContentType | null;
  /** false = diseñado pero pendiente de implementar (v2). */
  readonly available: boolean;
}

export const CHAT_MODE_DEFINITIONS: Readonly<Record<ChatMode, ChatModeDefinition>> = {
  movie: {
    id: 'movie',
    label: 'Película',
    labelEn: 'Movie',
    description: 'Una recomendación para ver ahora mismo.',
    contentType: 'movie',
    available: true,
  },
  tv: {
    id: 'tv',
    label: 'Serie',
    labelEn: 'Series',
    description: 'Algo con capítulos para dejarse llevar.',
    contentType: 'tv',
    available: true,
  },
  weekend: {
    id: 'weekend',
    label: 'Fin de semana',
    labelEn: 'Weekend',
    description: 'Un plan coherente para dos o tres días.',
    contentType: null,
    available: false,
  },
  month: {
    id: 'month',
    label: 'Mes otoñal',
    labelEn: 'Autumn month',
    description: 'Un calendario cinematográfico para todo el mes.',
    contentType: null,
    available: false,
  },
} as const;

/** Modos operativos en el MVP. */
export const AVAILABLE_CHAT_MODES: readonly ChatMode[] = CHAT_MODES.filter(
  (mode) => CHAT_MODE_DEFINITIONS[mode].available,
);

export function isChatMode(value: unknown): value is ChatMode {
  return typeof value === 'string' && (CHAT_MODES as readonly string[]).includes(value);
}

export function isAvailableChatMode(value: unknown): value is ChatMode {
  return isChatMode(value) && CHAT_MODE_DEFINITIONS[value].available;
}

// ─── Chat ────────────────────────────────────────────────────────────────────

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

/** Mensajes guardados en la columna `conversations.messages` (JSONB). */
export interface StoredChatMessage extends ChatMessage {
  readonly created_at: string;
}

export function isChatRole(value: unknown): value is ChatRole {
  return value === 'system' || value === 'user' || value === 'assistant';
}

// ─── Localización ────────────────────────────────────────────────────────────

export const LOCALES = ['es', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'es';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}
