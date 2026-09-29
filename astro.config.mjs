// @ts-check
import { defineConfig, envField, fontProviders } from 'astro/config';

import vercel from '@astrojs/vercel';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  // SSR: el chat necesita endpoints de servidor con streaming.
  output: 'server',
  adapter: vercel(),

  // Esquema de variables de entorno. Se consume siempre desde `src/lib/env.ts`.
  // `context: 'server'` impide que el bundle de cliente pueda importarlas.
  env: {
    schema: {
      // DeepSeek — solo chat (no tiene endpoint de embeddings)
      DEEPSEEK_API_KEY: envField.string({ context: 'server', access: 'secret' }),

      // Embeddings — servidor OpenAI-compatible con Qwen3-Embedding-0.6B
      EMBEDDINGS_URL: envField.string({
        context: 'server',
        access: 'public',
        default: 'http://127.0.0.1:8080/v1',
      }),
      // Solo si el servicio está detrás de un gateway autenticado.
      EMBEDDINGS_API_KEY: envField.string({
        context: 'server',
        access: 'secret',
        optional: true,
      }),

      // Supabase
      SUPABASE_URL: envField.string({ context: 'server', access: 'public' }),
      SUPABASE_PUBLISHABLE_KEY: envField.string({ context: 'server', access: 'secret' }),
      // Solo scripts de seed y endpoints de servidor. Nunca en cliente.
      SUPABASE_SECRET_KEY: envField.string({
        context: 'server',
        access: 'secret',
        optional: true,
      }),

      // TMDB
      TMDB_API_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
      TMDB_READ_ACCESS_TOKEN: envField.string({ context: 'server', access: 'secret' }),

      // App
      PUBLIC_APP_URL: envField.string({
        context: 'client',
        access: 'public',
        default: 'http://localhost:4321',
      }),
    },
  },

  // Fuentes autoalojadas y optimizadas en build. Se exponen como variables CSS
  // que consume el tema de Tailwind en `src/styles/global.css`.
  fonts: [
    {
      provider: fontProviders.google(),
      name: 'Playfair Display',
      cssVariable: '--font-playfair',
      weights: [400, 500, 600, 700],
      styles: ['normal', 'italic'],
      subsets: ['latin', 'latin-ext'],
      fallbacks: ['Georgia', 'serif'],
    },
    {
      provider: fontProviders.google(),
      name: 'Inter',
      cssVariable: '--font-inter',
      weights: [400, 500, 600],
      subsets: ['latin', 'latin-ext'],
      fallbacks: ['system-ui', 'sans-serif'],
    },
  ],

  vite: {
    plugins: [tailwindcss()],
  },
});
