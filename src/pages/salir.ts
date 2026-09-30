/**
 * POST /salir — cierra la sesión de este navegador. Solo POST: un enlace GET
 * permitiría cerrar la sesión de alguien con una imagen incrustada en otra web.
 */
import type { APIRoute } from 'astro';

import { errorMessage } from '@/lib/errors';

export const POST: APIRoute = async ({ locals, redirect }) => {
  // `local`: cierra solo este navegador, no las sesiones abiertas en otros.
  const { error } = await locals.supabase.auth.signOut({ scope: 'local' });
  if (error !== null) console.warn('[salir] signOut:', errorMessage(error));
  return redirect('/', 303);
};
