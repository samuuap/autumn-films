/// <reference types="astro/client" />

declare namespace App {
  /** Lo que el middleware (`src/middleware.ts`) deja preparado en cada petición. */
  interface Locals {
    /** Cliente con la sesión de las cookies: RLS se evalúa como quien la tenga. */
    supabase: import('@/lib/supabase').UmberSupabaseClient;
    /** `null` sin sesión. */
    user: import('@/lib/auth').SessionUser | null;
  }
}
