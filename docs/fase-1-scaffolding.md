# Fase 1 — Scaffolding y configuración base

**Estado:** ✅ Completada
**Depende de:** nada
**Actualizado:** 2026-09-29

## Objetivo

Dejar el proyecto arrancable, con TypeScript estricto, la estética otoñal
aplicada y los tres clientes externos (DeepSeek, Supabase, TMDB) listos para que
las fases siguientes solo tengan que usarlos.

## Hecho

### Configuración

- [x] Astro 7.3.5 con Tailwind 4 (`@tailwindcss/vite`) y adaptador
      `@astrojs/vercel`, en `output: 'server'` porque el chat necesita streaming
- [x] TypeScript con `astro/tsconfigs/strictest`, que además de `strict` activa
      `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`
      y `noImplicitReturns`
- [x] Alias `@/` → `src/` vía `tsconfig.json`, que Astro resuelve nativamente
- [x] Scripts de npm: `dev`, `build`, `preview`, `typecheck` (`astro check`), `sync`
- [x] `.gitignore` cubriendo `.env*` salvo `.env.example`, `.vercel/`, `dist/`,
      `__pycache__/` y `scripts/seed/data/`

### Variables de entorno

- [x] Esquema validado en `astro.config.mjs` con `astro:env`, así que el build
      falla si falta una obligatoria
- [x] `src/lib/env.ts` como único punto de acceso de servidor, con
      `requireSupabaseSecretKey()` para la clave que se salta RLS
- [x] `src/lib/env.client.ts` para lo público del navegador
- [x] `.env.example` versionado y `.env.local` ignorado

### Clientes

- [x] `src/lib/supabase.ts` — tres niveles de privilegio: anon con RLS, JWT del
      usuario, y secret key que se la salta. Helper `unwrap()` para no repetir
      el `if (error)` en cada consulta
- [x] `src/lib/database.types.ts` — tipo `Database` escrito a mano a partir del
      esquema de `CLAUDE.md`, regenerable con `supabase gen types`
- [x] `src/lib/deepseek.ts` — `deepseek-flash`, streaming por defecto
      (`streamChat`, `streamChatText`), `complete()` a temperatura 0.1 para
      extracción, tope de 600 tokens
- [x] `src/lib/embeddings.ts` — Qwen3-Embedding-0.6B a 1024 dim, con
      `embedQuery()` y `embedDocuments()` separadas, validación de dimensión y
      `toPgVector()`
- [x] `src/lib/tmdb.ts` — bearer v4, `append_to_response=watch/providers`,
      región `ES` por defecto, helpers de póster/backdrop y extracción de
      plataformas de suscripción

### Dominio

- [x] `src/lib/errors.ts` — jerarquía tipada (`UmberError` y derivados) más
      `toError()`, para poder cumplir la regla de `catch (error: unknown)`
- [x] `src/lib/types.ts` — tipos de contenido, mensajes y los 4 modos con
      metadatos. `weekend` y `month` preservados como `available: false`

### Presentación

- [x] `src/styles/global.css` — paleta otoñal como tokens de Tailwind con
      prefijo `umber-`, para no chocar con las escalas propias de Tailwind
- [x] Playfair Display e Inter autoalojadas con la API de fuentes de Astro
- [x] `src/layouts/Layout.astro` y un `src/pages/index.astro` de espera que
      verifica tema, tipografías y los 4 modos

## Pendiente

- [ ] Rellenar `.env.local` con credenciales reales de DeepSeek, Supabase y
      TMDB. Ahora lleva `REPLACE_ME` en cada una
- [ ] Levantar el contenedor de embeddings en local para poder probar la
      vectorización (ver [Fase 3](fase-3-seed-corpus.md))

## Decisiones tomadas

| Decisión | Motivo |
|---|---|
| `astro:env` en lugar de leer `import.meta.env` a mano | Valida en build y bloquea los secretos de servidor en el bundle de cliente. Cumple la regla de `CLAUDE.md` mejor que un módulo escrito a mano |
| `strictest` en lugar de solo `strict` | La convención pedía «TypeScript estricto». `strictest` añade las comprobaciones que de verdad pillan bugs (índices sin verificar, opcionales exactos) |
| Paleta prefijada `umber-` | `bg-amber-500` y compañía siguen disponibles sin ambigüedad |
| `SUPABASE_URL` y `SUPABASE_PUBLISHABLE_KEY` como server-only | Es lo que declara `CLAUDE.md` al no llevar prefijo `PUBLIC_`. Condiciona la auth de la [Fase 5](fase-5-frontend.md) |
| Archivos extra en `src/lib/` (`env`, `errors`, `types`, `database.types`) | `CLAUDE.md` solo listaba cuatro, pero `env.ts` lo exige la propia convención y `errors.ts` es lo que permite tipar los `catch`. El árbol de `CLAUDE.md` está actualizado |
| Fuentes con la API de Astro en vez de un `<link>` a Google Fonts | Autoalojadas: sin petición a terceros, sin salto de fuente y mejor privacidad |
| `getStreamingNames()` normaliza los nombres de TMDB | Los datos reales vienen sucios: espacios sobrantes, la misma plataforma repetida como canal de un revendedor («HBO Max» y «HBO Max Amazon Channel») y subservicios que son variantes de otro ya listado. Sin normalizar, Umber recita seis plataformas donde hay tres |

## Preguntas abiertas

Ninguna propia. Las tres que salieron en esta fase pertenecen a fases
posteriores: índice vectorial ([2](fase-2-base-de-datos.md)), auth
([5](fase-5-frontend.md)) y servicio de embeddings en producción
([6](fase-6-pulido-despliegue.md)).

## Verificación

```bash
npm run typecheck   # 0 errores, 0 warnings, 0 hints
npm run build       # genera .vercel/output
npm run dev         # http://localhost:4321 con tema y fuentes aplicados
```

Las tres credenciales están comprobadas contra sus APIs reales:

- **DeepSeek** — `/models` devuelve `deepseek-flash` y `deepseek-v4-pro`, lo que
  confirma que `deepseek-chat` no existe en la cuenta y que el modelo
  configurado es correcto. `/user/balance` responde con saldo disponible
- **TMDB** — el bearer v4 y la api_key v3 funcionan, y
  `append_to_response=watch/providers` devuelve plataformas de la región `ES`
- **Supabase** — publishable y secret válidas; `content` y `search_content`
  todavía no existen, que es el estado esperado antes de la Fase 2

El aislamiento de secretos se comprobó a propósito: una página con
`import { env } from '@/lib/env'` dentro de un `<script>` de cliente rompe el
build con `[ServerOnlyModule] The "astro:env/server" module is only available
server-side`. Ningún valor de `.env.local` aparece en `.vercel/output/static`.
