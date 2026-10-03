# Fase 6 — Pulido y despliegue

**Estado:** ⏳ Pendiente
**Depende de:** [Fase 5](fase-5-frontend.md) 🔄
**Actualizado:** 2026-09-30

## Objetivo

Dejar Umber en producción, en dos idiomas, usable en cualquier pantalla y con el
coste bajo control.

## Hecho

- [x] Adaptador `@astrojs/vercel` configurado y build generando
      `.vercel/output` correctamente
- [x] Tipografías autoalojadas, así que no hay petición a Google Fonts
- [x] `color-scheme: dark`, `prefers-reduced-motion` y `:focus-visible` ya
      contemplados en `src/styles/global.css`

## Pendiente

### Responsive y accesibilidad

- [ ] Repasar las tres pantallas en móvil, tablet y escritorio
- [ ] Contraste de la paleta contra WCAG AA. El punto a vigilar es el texto
      secundario `#8A7B6E` sobre el fondo `#0D0B08`: en tamaños pequeños puede
      quedarse corto
- [ ] Navegación completa por teclado y lector de pantalla. Ya hay enlace
      «Saltar al contenido», y la lista del chat lleva `aria-live="polite"` con
      `aria-busy` mientras llega el stream (Fase 5); falta probarlo con VoiceOver o
      NVDA, que anuncian los fragmentos de forma distinta
- [x] Textos alternativos: los carteles llevan «Cartel de <título>». El backdrop
      de la portada es decorativo (`alt=""`) y su título va escrito al pie

### i18n

- [ ] Español e inglés. `src/lib/types.ts` ya tiene `LOCALES`, `Locale` y
      `DEFAULT_LOCALE`
- [ ] Umber ya responde en el idioma de la persona: lo detecta el servidor
      (Fase 4). Falta traducir la interfaz
- [x] Usar `title_en` y `synopsis_en` del corpus cuando el idioma sea inglés:
      hecho en la Fase 4 para el chat y sus fichas. Queda `/favoritos`, que
      muestra el título español
- [x] Ajustar la región de streaming de TMDB según el idioma, en vez de `ES`
      fijo: el chat, `/favoritos` y `/api/tmdb` ya la sacan de `Accept-Language`
- [x] **Encontrar un título por su nombre en español** (2026-10-03). Eran dos
      fallos:
      1. **El texto vectorizado** solo llevaba el título inglés. Ahora
         `document_text()` añade el español cuando es otro (3.944 de 5.000).
         Corpus revectorizado en Cloudflare (124 lotes, gratis) y recargado.
         Búsqueda exacta, puesto del título antes → después: «El padrino» 72 → 3,
         «Cadena perpetua» 225 → 9, «Perdida» 45 → 2, «El silencio de los
         corderos» 17 → 1; los títulos ingleses siguen en el 1. En las búsquedas
         por ánimo con resúmenes en inglés (lo que usa el chat) coinciden 7,1 de
         cada 10 resultados, sin empeorar a ojo
      2. **Umber no llegaba a buscar.** `system.md` le pedía decir «no lo tengo»
         de cualquier título que no le hubiera dado una búsqueda, y en los dos
         primeros turnos no puede buscar. Ahora tiene `buscar_por_titulo`, en
         cualquier turno (ver la Fase 4). Probado con el chat: *El padrino*,
         *Cadena perpetua*, *Perdida*, *The Godfather* y *Stranger Things*
         encontrados, también como primer mensaje; *Titanic*, que no está, lo
         dice y sigue preguntando
- [x] **Índice HNSW tras la recarga.** Actualizar casi todo el corpus degradó el
      grafo: devolvía el 92,5 % de los 10 mejores frente a la búsqueda exacta, y
      se dejaba *La llegada* buscando «La llegada». `REINDEX` (de 70 a 39 MB) lo
      subió al 94 %, y `ef_search` 100 en `search_content`, al 97,5 %; las
      búsquedas por ánimo, al 100 %. Medido en 20 consultas

### Despliegue

- [ ] Proyecto de Vercel conectado al repositorio
- [ ] Variables de entorno en producción. El build falla si falta alguna
      obligatoria, que es justo el comportamiento que queremos
- [ ] `PUBLIC_APP_URL` apuntando al dominio real
- [ ] **Auth de Supabase apuntando solo a producción** (Authentication → URL
      Configuration): *Site URL* `https://<dominio>` y en *Redirect URLs*
      `https://<dominio>/auth/confirm`. Nada de `localhost` en este proyecto:
      `registro.astro` pide volver a `${Astro.url.origin}/auth/confirm`, y
      Supabase solo lo respeta si está en la lista. Para desarrollar con registro
      en local, un proyecto de Supabase aparte
- [ ] Plantilla *Confirm signup* con
      `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email`: con la
      de por defecto (`?code=`), el enlace solo funciona en el navegador del
      registro
- [ ] **SMTP propio** (Authentication → Emails → SMTP Settings). El correo por
      defecto de Supabase es para pruebas: limita mucho los envíos y no sirve para
      que se registre gente real
- [ ] Probar un registro de punta a punta con un email real, ya en producción
- [x] **Servicio de embeddings en producción: Cloudflare Workers AI**
      (`@cf/qwen/qwen3-embedding-0.6b`), por su API compatible con la de OpenAI.
      Gratis hasta 10.000 neuronas al día (el modelo gasta 1.075 por millón de
      tokens: unos 90.000 mensajes del chat); al pasarse, falla en vez de cobrar.
      **Da los mismos vectores que el corpus**: similitud 1,000000 en 20
      documentos y en 3 consultas con nuestra instrucción (no añade la suya), y el
      mismo top 10 en el mismo orden. No hay que reindexar
- [x] El nombre del modelo va en `EMBEDDINGS_MODEL` (el servidor local lo llama
      `Qwen/Qwen3-Embedding-0.6B`); `.env.local` ya apunta a Cloudflare y el
      servidor local queda para trabajar sin conexión.
      `scripts/seed/check-embeddings.py` comprueba cualquier servicio antes de
      usarlo
- [x] **Latencia de Cloudflare medida y aceptada** (decisión de producto). La red
      no es el problema (179 ms de mediana, desde Madrid); lo lento es la
      inferencia. Una consulta por minuto durante una hora (60): mediana 1,2 s,
      el 25 % por encima de 3,0 s, el 10 % por encima de 5,8 s, máximo 9,2 s,
      **0 errores**. Primer byte del chat con mensajes nuevos: mediana 5,0 s
      (1,9–7,4 s), frente a 1,9 s con el servidor local. El cliente espera ahora
      hasta 15 s por consulta (antes 10): en una ráfaga anterior hubo una de 11,7 s
- [ ] `EMBEDDINGS_URL`, `EMBEDDINGS_API_KEY` y `EMBEDDINGS_MODEL` en Vercel
- [ ] Comprobar que el despliegue de vista previa de Vercel también alcanza ese
      servicio

### Seguridad

- [x] **CSP y cabeceras de seguridad** (2026-10-03). CSP con `security.csp` de
      Astro: hashes de scripts y estilos propios, imágenes solo de
      `image.tmdb.org`, `frame-ancestors 'none'`. El middleware añade
      `X-Content-Type-Options`, `X-Frame-Options` y `Referrer-Policy`. Probado
      sobre el build con Chromium: las seis páginas sin ninguna violación, y un
      script en línea y una imagen externa inyectados a propósito, bloqueados
- [ ] Comprobar en el despliegue de vista previa: la barra de Vercel
      (`vercel.live`) es un script externo y el CSP la bloqueará. No afecta a la
      web, pero ensuciará la consola

### Operación

- [x] Rate limiting en `/api/chat`: hecho en la [Fase 4](fase-4-api-chat.md),
      por usuario o por IP (`src/lib/rate-limit.ts`)
- [x] `SUPABASE_SECRET_KEY` en las variables de Vercel, que el rate limiting del
      chat necesita
- [x] **Región de las funciones de Vercel junto a Supabase** (`eu-west-1`,
      Irlanda: `dub1`), en `vercel.json` (2026-10-03). Al desplegar, comprobar
      en los logs de la función que corre en `dub1`; si no, se elige en Project
      Settings → Functions. Por defecto Vercel las pone en `iad1` (Washington). Cada
      mensaje del chat hace al menos tres viajes a Supabase antes del primer token
      (rate limit, búsqueda, caché de plataformas), y desde local ya cuestan unos
      120 ms cada uno. En `iad1` los tres cruzarían el Atlántico, con el primer
      byte ya en el límite de los 2 s (ver la tabla de la Fase 4)
- [ ] Alguna forma de ver los errores en producción, aunque sea los logs de
      Vercel
- [x] **Tope global de gasto de DeepSeek** (2026-10-03): 300 mensajes al día
      entre todos (`chat:global` en `src/lib/rate-limit.ts`), unos 0,30 USD como
      mucho. Solo cuenta lo que cabe en el límite de cada persona: si contara lo
      rechazado, una sola IP insistiendo agotaría el cupo de todos. Por persona,
      50 al día con cuenta y una conversación de prueba (20) sin ella: ninguna
      sola agota el cupo global (ver la Fase 4)
- [ ] Vigilar el gasto de DeepSeek. `deepseek-flash` es barato, pero el coste va
      por conversación. El endpoint
      `/user/balance` de DeepSeek sirve para consultarlo por API. A 2026-09-30 la
      cuenta tiene 9,58 USD, tras recargar. Repuntuar el corpus entero (3 pasadas)
      costó unos 1,20 USD

## Decisiones tomadas

| Decisión | Motivo |
|---|---|
| `output: 'server'` con adaptador de Vercel | El chat necesita streaming en servidor. La portada podría prerenderizarse más adelante si interesa |
| Fuentes autoalojadas | Sin terceros, sin salto de fuente y una petición externa menos |
| **Sin gastos fijos**: Vercel Hobby, Supabase Free, subdominio `vercel.app` y un SMTP con plan gratuito. Solo se paga DeepSeek, por uso | Decisión de producto. El plan Hobby de Vercel es para uso no comercial |
| **Embeddings en Cloudflare Workers AI**, gratis, aceptando su latencia | El mismo modelo, con vectores idénticos a los del corpus: no hay que reindexar ni mantener un servidor, no se duerme y al pasarse del límite gratuito falla en vez de cobrar. Descartados: un servicio de pago (decisión de producto); un Space de Hugging Face, que desde julio de 2026 exige PRO (9 $/mes) para Docker y Gradio en CPU; el modelo que Supabase ejecuta gratis (gte-small), que solo entiende inglés y obligaría a reindexar. Se acepta la latencia (mediana de 1,2 s por consulta, picos de varios segundos) a cambio de no mantener nada. Si algún día molesta, dos alternativas gratuitas, en este orden: **`@cf/baai/bge-m3` en el mismo Cloudflare** (99 ms de mediana y 186 de máximo en 12 muestras; multilingüe y de 1024 dimensiones, pero obliga a revectorizar el corpus y recalibrar la búsqueda), o una **VM de Oracle Cloud «Always Free»** en Madrid con `server.py` (2 CPU ARM y 12 GB; se estima entre 0,3 y 1 s por consulta en CPU, sin medir; pide tarjeta, que no se cobra sin pasar a pago, y Oracle recupera las máquinas inactivas 7 días) |

## Preguntas abiertas

**1. ~~¿Dónde corre el servicio de embeddings en producción?~~** Resuelta el
2026-09-30: en un Space de Hugging Face con CPU gratuita (ver Decisiones).

**2. ¿Región de despliegue?**
El público objetivo es España. Conviene que la función de Vercel, el proyecto de
Supabase y el servicio de embeddings estén en la misma región europea: cada salto
transatlántico se suma antes del primer token que ve el usuario.

## Verificación

- Umber funciona en producción de punta a punta: mensaje, búsqueda, respuesta en
  streaming y guardado
- Contraste AA verificado con herramienta, no a ojo
- La interfaz cambia de idioma y Umber responde en el mismo
- Ningún secreto en el bundle de cliente, comprobado sobre el build de producción
