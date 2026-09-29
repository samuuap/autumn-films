/**
 * Variables de entorno accesibles desde el navegador.
 *
 * Solo puede contener valores públicos (prefijo `PUBLIC_`). Cualquier secreto va
 * en `src/lib/env.ts`, que es exclusivamente de servidor.
 */
import { PUBLIC_APP_URL } from 'astro:env/client';

export const clientEnv = {
  appUrl: PUBLIC_APP_URL,
} as const;
