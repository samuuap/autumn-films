/**
 * Tipos de dominio de Umber.
 *
 * Los tipos de fila de la base de datos viven en `database.types.ts`; aquí están
 * los que usa la aplicación (modos, mensajes, candidatos enriquecidos).
 */
import type { Database } from '@/lib/database.types';

// ─── Contenido ───────────────────────────────────────────────────────────────

export type ContentType = 'movie' | 'tv';
export type ContentStatus = 'released' | 'ended' | 'ongoing';

/*
 * `database.types.ts` lo genera `supabase gen types` desde el esquema real, así
 * que manda en la forma de las tablas. Pero hay dos cosas del esquema que no
 * sabe expresar, y se corrigen aquí:
 *
 *  1. Las columnas con `CHECK` salen como `string`: el generador solo convierte
 *     en uniones los ENUM de Postgres. Se estrechan a los valores del
 *     constraint, que la base ya garantiza.
 *  2. `search_content` devuelve todos sus campos como NO nulables, porque el
 *     generador no puede inferir nullabilidad de un `RETURNS TABLE`. Varias de
 *     esas columnas sí son nulas en el corpus, y sin corregirlo el compilador
 *     dejaría pasar un `candidate.director.trim()` que reventaría en ejecución.
 *
 * Al regenerar los tipos, comprobar si estas correcciones siguen haciendo falta.
 */
type ContentRow = Database['public']['Tables']['content']['Row'];
type ConversationRow = Database['public']['Tables']['conversations']['Row'];
type SearchContentRow = Database['public']['Functions']['search_content']['Returns'][number];

/** Fila completa de la tabla `content`. */
export type Content = Omit<ContentRow, 'type' | 'status'> & {
  type: ContentType;
  status: ContentStatus | null;
};

export type ContentInsert = Database['public']['Tables']['content']['Insert'];

/** Candidato devuelto por la búsqueda semántica, con su score de similitud. */
export type ContentCandidate = Omit<
  SearchContentRow,
  'type' | 'year' | 'director' | 'synopsis' | 'genres' | 'autumn_score' | 'poster_path'
> & {
  type: ContentType;
  year: number | null;
  director: string | null;
  synopsis: string | null;
  genres: string[] | null;
  autumn_score: number | null;
  poster_path: string | null;
};

export type Conversation = Omit<ConversationRow, 'mode'> & { mode: ChatMode };
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

// ─── API del chat ────────────────────────────────────────────────────────────

/** Un estado de ánimo cabe de sobra; más es pegar documentos, no conversar. */
export const MAX_MESSAGE_CHARS = 1000;
/** Mensajes de historial que acepta el endpoint. El navegador recorta a esta cifra. */
export const MAX_HISTORY_MESSAGES = 40;

/** Cuerpo de `POST /api/chat`. Lo valida `parseChatRequest` en `src/lib/chat.ts`. */
export interface ChatRequestBody {
  readonly mode: ChatMode;
  readonly message: string;
  /**
   * Turnos anteriores, solo para quien no tiene conversación guardada. Con
   * `conversation_id`, el servidor lee el historial de Supabase y lo ignora.
   */
  readonly history?: readonly ChatMessage[];
  /** Conversación guardada que se continúa. Exige sesión. */
  readonly conversation_id?: string;
  readonly locale?: Locale;
  /** Región de plataformas, ISO 3166-1 alfa-2 (`ES`, `MX`…). */
  readonly region?: string;
}

/** Título que Umber ha recomendado, con lo que necesita la ficha de contenido. */
export interface Recommendation {
  /** `content.id`: lo que se guarda en `users_favorites`. */
  readonly id: string;
  readonly tmdb_id: number;
  readonly type: ContentType;
  readonly title: string;
  readonly year: number | null;
  readonly director: string | null;
  readonly genres: readonly string[];
  readonly poster_url: string | null;
  /** Suscripción o gratis en la región. `null` si TMDB no respondió a tiempo. */
  readonly platforms: readonly string[] | null;
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    /** Redactado para mostrarlo tal cual a la persona. */
    readonly message: string;
  };
}

/**
 * Eventos del stream SSE de `POST /api/chat`, en este orden: `delta` tantas veces
 * como fragmentos, y al final `done` o `error`. Un fallo antes de empezar no
 * abre stream: llega como JSON `ApiErrorBody` con su código HTTP.
 */
export type ChatStreamEvent =
  | { readonly event: 'delta'; readonly data: { readonly text: string } }
  | {
      readonly event: 'done';
      readonly data: {
        /** `null` sin sesión, o si guardar falló: la respuesta llegó igual. */
        readonly conversation_id: string | null;
        readonly recommendations: readonly Recommendation[];
      };
    }
  | { readonly event: 'error'; readonly data: ApiErrorBody['error'] };

// ─── Localización ────────────────────────────────────────────────────────────

export const LOCALES = ['es', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'es';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}
