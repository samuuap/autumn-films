# Fase 5 — Frontend

**Estado:** 🔄 En curso — código completo; falta configurar las URLs de auth en
Supabase y probar un registro con un email real
**Depende de:** [Fase 4](fase-4-api-chat.md) 🔄 — la UI consume `/api/chat`, que ya funciona
**Actualizado:** 2026-09-30

## Objetivo

Construir la interfaz: elegir modo, conversar con Umber viendo cómo escribe, ver
la ficha de lo que recomienda y poder guardarlo.

## Hecho

- [x] `src/layouts/Layout.astro` con tema, tipografías y metadatos, y ahora
      cabecera, pie y enlace «Saltar al contenido»
- [x] Tokens de la paleta otoñal disponibles como clases de Tailwind
      (`bg-umber-base`, `text-umber-amber`…)

### Pantalla de inicio

- [x] Selector de los 4 modos leyendo de `CHAT_MODE_DEFINITIONS` (`ModeCard`)
- [x] `weekend` y `month` visibles con «Próximamente» y sin enlace
- [x] Hero con el backdrop de un título con `autumn_score` ≥ 0,85, distinto en
      cada visita, y su título al pie. `srcset` con `w780`, `w1280` y `original`:
      el `original` que pedía `CLAUDE.md` pesa varios MB, y en móvil sobra

### Chat

- [x] `src/pages/chat.astro`: `/chat?mode=movie` para empezar,
      `/chat?conversation=<id>` para retomar. Un modo de v2 o desconocido vuelve
      a la portada
- [x] Stream de `/api/chat` pintado según llega (`src/lib/chat-stream.ts` lee el
      SSE con `fetch`; `src/scripts/chat.ts` lo pinta)
- [x] Sin sesión, el historial va en memoria y viaja en cada petición. Con sesión,
      tras el primer turno la URL pasa a `?conversation=<id>`: recargar retoma la
      conversación en vez de empezar otra
- [x] «Buscando en el catálogo…» hasta el primer fragmento
- [x] Errores con «Reintentar», que reutiliza la respuesta fallida sin duplicar el
      mensaje. «Detener» corta la generación (el servidor deja de pagar tokens) y
      también ofrece reintentar
- [x] Autoscroll solo si la persona estaba al final: si ha subido a leer, no se
      la mueve
- [x] Sugerencias de arranque por modo, Intro para enviar, Mayúsculas + Intro
      para salto de línea, y el cuadro de texto crece con lo escrito
- [x] El texto de Umber se escapa antes de dar formato (`src/lib/markdown.ts`):
      viene de un LLM

### Ficha de contenido

- [x] `ContentCard`: cartel `w500` con texto alternativo, tipo, título, año,
      dirección (creación en series), géneros y plataformas. Llega en
      `recommendations` del evento `done`, sin otra llamada
- [x] Debajo de la explicación de Umber, que es el diferencial del producto
- [x] «Sin cartel» cuando `poster_path` es nulo
- [x] Plataformas desconocidas (TMDB no respondió) no se muestran; «ninguna» se
      dice

### Auth y favoritos

- [x] Sesión en cookies `httpOnly` con `@supabase/ssr`. El middleware la verifica
      en cada petición (en local, con las claves ES256 del proyecto) y la renueva
      cuando caduca
- [x] `/entrar` y `/registro` funcionan sin JavaScript. Errores de Supabase en
      español; el registro no revela si un email ya tenía cuenta
- [x] `/auth/confirm` acepta el `?code=` de la plantilla por defecto y el
      `?token_hash=` de la recomendada para SSR
- [x] `POST /salir`, solo POST y solo este navegador
- [x] `?next=` tras entrar, y solo a rutas de esta web
- [x] Favoritos: `POST` y `DELETE /api/favorites`, botón con `aria-pressed` y
      cambio optimista que vuelve atrás si el servidor falla
- [x] `/favoritos`, con plataformas pedidas a TMDB desde el servidor
- [x] `/conversaciones`, las 50 más recientes, sin cargar los mensajes enteros
      (`messages->0->>content`)

### Componentes

- [x] `SiteHeader`, `SiteFooter` (con la atribución que exigen TMDB y JustWatch),
      `ModeCard`, `ContentCard`, `ChatMessage` y `AuthForm`. `ProviderList` no
      hizo falta: son cuatro líneas dentro de la ficha

## Pendiente

### Configuración en Supabase (una vez, en el dashboard)

- [ ] **Authentication → URL Configuration**: *Site URL* con la URL de la app, y
      en *Redirect URLs* `http://localhost:4321/auth/confirm` y la de producción.
      Sin esto, el enlace del email de confirmación vuelve a `localhost:3000`
- [ ] Opcional: cambiar la plantilla *Confirm signup* a
      `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email`. Con
      la plantilla por defecto, el enlace solo funciona en el navegador donde la
      persona se registró
- [ ] Probar un registro de punta a punta con un email real. No se ha hecho aquí
      a propósito: registrar emails inventados hace rebotar el SMTP por defecto de
      Supabase, que limita los envíos y castiga los rebotes

### Mejoras vistas al probar

- [ ] Una conversación retomada muestra el texto pero no las fichas: la
      conversación guardada no recuerda qué títulos eran. Se arregla guardando los
      ids recomendados en cada mensaje del asistente
- [ ] Sin sesión, pulsar «Entrar» en la cabecera en mitad de una charla la
      pierde, porque solo vive en memoria. Las fichas abren el login en otra
      pestaña por eso mismo; la cabecera no
- [ ] Recuperar la contraseña: no estaba en el alcance de la fase

## Decisiones tomadas

| Decisión | Motivo |
|---|---|
| Los modos se leen de `CHAT_MODE_DEFINITIONS` | Una sola fuente de verdad. Añadir o activar un modo es tocar `src/lib/types.ts` y nada más |
| **Auth por SSR con cookies** (antes pregunta 1) | Las claves de Supabase siguen solo en servidor, encaja con «nada de `localStorage`» y RLS se evalúa en servidor. `/api/chat` y `/api/favorites` aceptan además `Authorization: Bearer`, para scripts |
| Cookies de sesión `httpOnly` | No hay cliente de Supabase en el navegador, así que nadie necesita leerlas desde JavaScript, y un XSS no puede llevarse la sesión. Comprobado en el navegador: `httpOnly` y `SameSite=Lax` |
| **JavaScript a pelo** para el chat (antes pregunta 2) | Una pantalla y poco estado. El proyecto sigue sin dependencias de framework |
| **Sin cuenta, historial solo en memoria** (antes pregunta 3) | Cero código extra; el endpoint ya lo soportaba. Activar la sesión anónima de Supabase más adelante no obliga a tocar `/api/chat` |
| La ficha se pinta en el servidor o se clona de un `<template>` con el mismo componente | Un solo marcado para las dos. `describeCard` formatea igual en servidor y navegador |
| El chat activa los botones de favorito él mismo | Astro emite el `<script>` de un componente donde el componente se pinta, y dentro de un `<template>` queda inerte. Lo encontró la prueba en navegador: con sesión, «Guardar» no hacía nada |
| El estilo de las plataformas va en la lista, no en cada `<li>` | Los `<li>` que crea el chat no llevan clases; con selectores `[&>li]:` se ven igual que los del servidor |
| El mensaje del usuario y el texto de Umber se pintan con `textContent` y con `renderReply`, que escapa antes de formatear | El texto de un LLM no es HTML de confianza |
| Las fichas sin sesión enlazan al login en otra pestaña | La charla sin cuenta vive en memoria: navegar la perdería. Tras entrar en la otra pestaña, el siguiente mensaje ya va con sesión y el endpoint guarda también lo anterior |
| Favoritos: quitar uno no lo borra de la lista hasta recargar | Deshacer un clic por error es volver a pulsar |
| Formularios de auth sin JavaScript, procesados en la propia página | Menos código, y `checkOrigin` de Astro (activo por defecto) rechaza los POST de otros sitios |

## Preguntas abiertas

Ninguna propia. Las decisiones de producto de esta fase están tomadas.

## Verificación

Probado en Chromium real con Playwright, contra los servicios reales, en
escritorio (1280 px) y móvil (iPhone 13):

- [x] **Móvil**: portada y chat se leen y se usan bien; la ficha cabe junto al
      cartel
- [x] **Teclado**: el primer Tab lleva a «Saltar al contenido»; foco visible con
      el `:focus-visible` del tema
- [x] **Sin cuenta**: dos turnos seguidos sin repetir título, con Intro; la URL no
      cambia; «Entra para guardarla» en vez del botón
- [x] **Con cuenta**, 24 de 24 comprobaciones: contraseña mala con mensaje en
      español, redirección a `?next`, cookie `httpOnly`, la URL pasa a la
      conversación, recargar la retoma y continúa sin repetir, aparece en
      `/conversaciones`, «Guardar» persiste y sale en `/favoritos` con
      plataformas, quitarlo lo borra, salir, `/favoritos` pide entrar, enlace de
      confirmación con `token_hash` abre sesión, `?next` externo descartado
- [x] **Errores**: un 502 muestra el mensaje y «Reintentar» funciona sin duplicar;
      «Detener» corta y deja volver a enviar
- [x] **Ninguna llamada del navegador a la API de TMDB**: 0 peticiones. Solo
      imágenes de `image.tmdb.org`
- [x] Sin errores de JavaScript en consola; typecheck y build limpios; ni el
      system prompt ni secretos en los estáticos del build
