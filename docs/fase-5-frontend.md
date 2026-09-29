# Fase 5 — Frontend

**Estado:** ⏳ Pendiente
**Depende de:** [Fase 4](fase-4-api-chat.md) ⏳ — la UI consume `/api/chat`
**Actualizado:** 2026-09-29

## Objetivo

Construir la interfaz: elegir modo, conversar con Umber viendo cómo escribe, ver
la ficha de lo que recomienda y poder guardarlo.

## Hecho

- [x] `src/layouts/Layout.astro` con tema, tipografías y metadatos
- [x] Tokens de la paleta otoñal disponibles como clases de Tailwind
      (`bg-umber-base`, `text-umber-amber`…)
- [x] `src/pages/index.astro` provisional, que solo verifica que el andamiaje
      funciona. **Se sustituye en esta fase**

## Pendiente

### Pantalla de inicio

- [ ] Selector de los 4 modos leyendo de `CHAT_MODE_DEFINITIONS`, no de una lista
      escrita a mano
- [ ] `weekend` y `month` visibles pero deshabilitados, con su etiqueta de v2:
      están diseñados y no se eliminan
- [ ] Hero con backdrop, según la nota de `CLAUDE.md` sobre
      `https://image.tmdb.org/t/p/original{backdrop_path}`

### Chat

- [ ] `src/pages/chat.astro`, con el modo en la URL para que la página sea
      compartible y recargable
- [ ] Consumir el stream de `/api/chat` y pintar el texto a medida que llega
- [ ] Estado de espera mientras se vectoriza y se busca, que es la parte lenta
      antes del primer token
- [ ] Errores visibles y recuperables: si el servicio de embeddings no responde,
      la persona tiene que poder reintentar sin recargar
- [ ] Autoscroll que no pelee con el usuario si sube a leer

### Ficha de contenido

- [ ] Póster (`w500`), título, año, director, plataformas
- [ ] La explicación de Umber junto a la ficha, que es el diferencial del
      producto: no es un catálogo, es el «por qué esta para ti»
- [ ] Estado sin póster: hay títulos del corpus con `poster_path` nulo

### Auth y favoritos

- [ ] Registro y login con Supabase Auth. Estado actual del proyecto,
      comprobado contra `/auth/v1/settings`: email activado, registro abierto,
      ningún proveedor OAuth y sesión anónima desactivada
- [ ] Añadir y quitar favoritos contra `users_favorites`
- [ ] Listado de favoritos del usuario
- [ ] Recuperar conversaciones anteriores

### Componentes

- [ ] Poblar `src/components/`, que sigue vacío. Candidatos claros:
      `ModeCard`, `ChatMessage`, `ContentCard`, `ProviderList`

## Decisiones tomadas

| Decisión | Motivo |
|---|---|
| Los modos se leen de `CHAT_MODE_DEFINITIONS` | Una sola fuente de verdad. Añadir o activar un modo es tocar `src/lib/types.ts` y nada más |

## Preguntas abiertas

**1. ¿Auth por SSR con cookies o cliente de Supabase en el navegador?**
`CLAUDE.md` declara `SUPABASE_URL` y `SUPABASE_PUBLISHABLE_KEY` sin prefijo `PUBLIC_`,
así que hoy son server-only y el navegador no puede crear un cliente de Supabase.
Eso empuja a auth por SSR con cookies, que encaja bien con la regla de «nada de
`localStorage`» y con que RLS se evalúe en servidor. La alternativa es añadir
`PUBLIC_SUPABASE_URL` y `PUBLIC_SUPABASE_PUBLISHABLE_KEY` y usar el cliente en el
navegador, que simplifica el login social y el refresco de sesión a cambio de
llevar la gestión de sesión al cliente.

**2. ¿Isla de framework para el chat o JavaScript a pelo?**
Un chat con streaming es viable con un `<script>` de Astro y nada más: no hay
estado compartido complejo. Meter React, Svelte o Solid añade bundle a cambio de
comodidad al gestionar la lista de mensajes. A favor de vanilla: el proyecto no
tiene hoy ninguna dependencia de framework y el chat es una sola pantalla.

## Verificación

- El chat funciona en móvil, que es donde se va a usar de verdad
- Navegable con teclado y con foco visible
- Sin cuenta se puede chatear (según se resuelva la pregunta 1 de la
  [Fase 4](fase-4-api-chat.md)); con cuenta, los favoritos persisten
- Ninguna llamada del navegador va a TMDB directamente
