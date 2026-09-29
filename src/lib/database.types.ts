/**
 * Tipos de la base de datos de Supabase.
 *
 * Escritos a mano a partir del esquema documentado en CLAUDE.md. Cuando el
 * proyecto de Supabase exista (Fase 2) se pueden regenerar con:
 *
 *   npx supabase gen types typescript --project-id <id> > src/lib/database.types.ts
 *
 * Nota sobre `embedding`: PostgREST serializa las columnas `vector` como string
 * (`"[0.1,0.2,...]"`). En los `Insert` se acepta además `number[]`, que Postgres
 * castea solo.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type ContentTypeColumn = 'movie' | 'tv';
export type ContentStatusColumn = 'released' | 'ended' | 'ongoing';
export type ConversationModeColumn = 'movie' | 'tv' | 'weekend' | 'month';

interface ContentRow {
  id: string;
  tmdb_id: number;
  type: ContentTypeColumn;
  title: string;
  title_en: string | null;
  year: number | null;
  director: string | null;
  synopsis: string | null;
  synopsis_en: string | null;
  genres: string[] | null;
  keywords: string[] | null;
  autumn_score: number | null;
  embedding: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  runtime: number | null;
  seasons: number | null;
  status: ContentStatusColumn | null;
  created_at: string;
}

interface ContentInsert {
  id?: string | undefined;
  tmdb_id: number;
  type: ContentTypeColumn;
  title: string;
  title_en?: string | null | undefined;
  year?: number | null | undefined;
  director?: string | null | undefined;
  synopsis?: string | null | undefined;
  synopsis_en?: string | null | undefined;
  genres?: string[] | null | undefined;
  keywords?: string[] | null | undefined;
  autumn_score?: number | null | undefined;
  embedding?: string | number[] | null | undefined;
  poster_path?: string | null | undefined;
  backdrop_path?: string | null | undefined;
  runtime?: number | null | undefined;
  seasons?: number | null | undefined;
  status?: ContentStatusColumn | null | undefined;
  created_at?: string | undefined;
}

interface UsersFavoritesRow {
  id: string;
  user_id: string | null;
  content_id: string | null;
  created_at: string;
}

interface ConversationsRow {
  id: string;
  user_id: string | null;
  mode: ConversationModeColumn;
  messages: Json;
  created_at: string;
  updated_at: string;
}

/** Fila que devuelve la función SQL `search_content`. */
export interface SearchContentRow {
  id: string;
  tmdb_id: number;
  type: ContentTypeColumn;
  title: string;
  year: number | null;
  director: string | null;
  synopsis: string | null;
  genres: string[] | null;
  autumn_score: number | null;
  poster_path: string | null;
  similarity: number;
}

export interface Database {
  public: {
    Tables: {
      content: {
        Row: ContentRow;
        Insert: ContentInsert;
        Update: Partial<ContentInsert>;
        Relationships: [];
      };
      users_favorites: {
        Row: UsersFavoritesRow;
        Insert: {
          id?: string | undefined;
          user_id?: string | null | undefined;
          content_id?: string | null | undefined;
          created_at?: string | undefined;
        };
        Update: {
          id?: string | undefined;
          user_id?: string | null | undefined;
          content_id?: string | null | undefined;
          created_at?: string | undefined;
        };
        Relationships: [];
      };
      conversations: {
        Row: ConversationsRow;
        Insert: {
          id?: string | undefined;
          user_id?: string | null | undefined;
          mode: ConversationModeColumn;
          messages?: Json | undefined;
          created_at?: string | undefined;
          updated_at?: string | undefined;
        };
        Update: {
          id?: string | undefined;
          user_id?: string | null | undefined;
          mode?: ConversationModeColumn | undefined;
          messages?: Json | undefined;
          created_at?: string | undefined;
          updated_at?: string | undefined;
        };
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      search_content: {
        Args: {
          query_embedding: string | number[];
          content_type?: ContentTypeColumn | null | undefined;
          match_count?: number | undefined;
          min_score?: number | undefined;
        };
        Returns: SearchContentRow[];
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
}
