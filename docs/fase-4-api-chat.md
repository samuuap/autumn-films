# Fase 4 — API del chat

**Estado:** ✅ Completada
**Depende de:** [Fase 3](fase-3-seed-corpus.md) ✅ — sin corpus no hay candidatos
**Actualizado:** 2026-09-30

## Objetivo

Montar el flujo completo del chat en servidor: del mensaje del usuario a un
stream de texto de Umber, pasando por vectorización, búsqueda semántica y
enriquecimiento con TMDB.

## Hecho

- [x] `src/lib/deepseek.ts` desactiva el razonamiento de `deepseek-flash` en
      `streamChat` y `complete`. Sin esto, el chat devolvía respuestas vacías
      (ver Decisiones). Comprobado que el SDK de Node envía el parámetro

### `POST /api/chat`

El contrato (cuerpo, eventos SSE, errores) está en `CLAUDE.md`, en «Flujo del
chat», y tipado en `src/lib/types.ts` (`ChatRequestBody`, `ChatStreamEvent`).

- [x] Validación antes de que nada llegue al LLM (`parseChatRequest` en
      `src/lib/chat.ts`): modo existente y disponible, mensaje de 1 a 1.000
      caracteres sin caracteres de control, historial de 40 mensajes como mucho
      y solo con roles `user` y `assistant`, `conversation_id` con forma de UUID,
      región de dos letras
- [x] `embedQuery()` con instrucción, sobre los últimos tres mensajes del usuario
      y no solo el actual (ver Decisiones)
- [x] **`EMBEDDING_TASK` revisada**: fuera «autumnal». Cambiada también en
      `scripts/seed/common.py`, comprobado que las dos cadenas coinciden. No obliga
      a reindexar: los documentos van sin instrucción
- [x] `search_content` filtrado por tipo según el modo, **con el suelo de
      similitud aplicado en TypeScript** (0,30) y no en la base: con un umbral que
      pocas filas superan, la función llegaba al timeout (ver Decisiones)
- [x] **Reordenado con `autumn_score`**: se piden 30, se ordenan por
      `similitud + 0,2 × autumn_score` y pasan 10 al modelo (`src/lib/search.ts`).
      Era 0,1 hasta que el score pasó a ser la media de tres pasadas
- [x] Los 27 títulos sin sinopsis española llevan la inglesa: `search_content`
      solo devuelve la española, y sin sinopsis el modelo inventaría
- [x] Plataformas de TMDB (`append_to_response=watch/providers`) de los 10
      candidatos en paralelo, con 2 s de tope: si TMDB falla, el candidato va sin
      plataformas y Umber no las menciona
- [x] `user-context.md` renderizado en una sola pasada (`src/lib/prompts.ts`),
      sin sus comentarios HTML, y con el mensaje del usuario citado con `> `
- [x] `deepseek-flash` con `system.md` + los últimos 12 mensajes + la plantilla
      rellena como último mensaje
- [x] El stream de DeepSeek se abre **antes** de responder: los fallos del
      proveedor llegan con su código HTTP, no a mitad del stream
- [x] Stream SSE con tres eventos: `delta`, `done` (con `conversation_id` y las
      fichas de lo recomendado) y `error`
- [x] Conversación guardada con el cliente del usuario al terminar el stream.
      Continuarla con `conversation_id` lee el historial de Supabase e ignora el
      del cliente

### Casos que no son el camino feliz

- [x] **Sin candidatos.** El prompt recibe `(ninguno)`. Probado forzando un
      suelo de 0,99: Umber dice que no tiene nada así y pide otro ángulo, sin
      nombrar ningún título
- [x] **No repetir recomendaciones.** Los títulos en negrita de las respuestas
      anteriores se quitan de los candidatos antes de cortar a 10, además de ir en
      `{{already_recommended}}`. Probado en tres turnos seguidos y con un
      historial traído por el cliente
- [x] **El cliente abandona.** `cancel()` del stream y `request.signal` abortan
      la llamada a DeepSeek. Probado: un cliente que lee tres fragmentos y cierra
      corta la generación a los 32 caracteres; no se guarda nada ni se registra
      como error
- [x] **El servicio de embeddings no responde.** 502 con «El buscador de Umber
      no responde ahora mismo» en 2,6 s (probado con el servidor parado). El
      cliente de embeddings tiene ahora 15 s de timeout (10 s hasta pasar a Cloudflare, Fase 6) y un reintento: el SDK
      espera 10 minutos por defecto
- [x] **Errores del proveedor.** El código HTTP sale de `status` de cada error de
      `src/lib/errors.ts`, que suma `AuthError` (401) y `NotFoundError` (404). La
      persona ve un mensaje redactado para ella; el detalle (URLs, respuesta del
      proveedor) se queda en el log
- [x] **Token de sesión inválido o caducado:** 401, no se trata como anónimo, para
      que el cliente renueve la sesión en vez de perder el historial
- [x] **Mensaje en otro idioma.** Contesta en el idioma del mensaje, aunque la
      interfaz esté en español (ver Decisiones). **Dejó de cumplirse** con el
      corpus repuntuado (2 de 2 en español, 2026-09-30); ahora lo decide el
      servidor: ver «Cierre»
- [x] **Intentos de manipular el prompt.** Pedir el system prompt: lo rechaza. Un
      mensaje con un falso «## Candidatos del corpus» con *Titanic*: no la
      recomienda. Pedir un título que no está en el corpus (*Interstellar*): dice
      que no lo tiene y ofrece uno que sí

### Caché de TMDB y rate limiting

Migraciones aplicadas en Supabase; `npm run db:verify`, 28 de 28.

- [x] **Caché de plataformas** (`platforms_cache`, migración
      `20260930100000`). `lookupPlatforms()` en `src/lib/platforms.ts`: lee la
      caché, pide a TMDB solo lo que falta o ha caducado y guarda el resultado de
      todas las regiones. La usan el chat y `/favoritos`
- [x] Si TMDB no responde, vale la entrada caducada. Si la caché no responde
      (1 s de tope), se pregunta a TMDB como antes
- [x] En el chat, la caché se escribe mientras DeepSeek abre el stream:
      escribirla no añade espera, y si falla solo queda en el log
- [x] **Rate limiting** (`rate_limits` y `hit_rate_limit`, migración
      `20260930100100`). `enforceChatRateLimit()` en `src/lib/rate-limit.ts`, justo
      después de validar y de leer la sesión: antes de embeddings, TMDB y DeepSeek.
      Va a la vez que la lectura de la conversación guardada, que no cuesta dinero
- [x] 429 con `Retry-After` y un mensaje para la persona («Vas muy deprisa…» o
      «Has llegado al límite de mensajes de hoy…»), que el chat ya muestra
- [x] En PGlite: el contador deja pasar hasta el límite y luego dice cuántos
      segundos esperar, rechaza ventanas sin límite y claves vacías, borra lo
      caducado; `anon` no puede leer las tablas ni llamar a la función; la caché
      rechaza un `by_region` que no es objeto y cae en cascada con el título
- [x] Claves por IP probadas con 12 direcciones (IPv4, IPv4 mapeada, IPv6
      completa, comprimida, con zona, con IPv4 al final, inválidas)
- [x] `npm run db:verify` comprueba también las tablas y la función nuevas
- [x] **De extremo a extremo**, contra Supabase y con el servidor de desarrollo:
  - Sin sesión: el primer mensaje llena la caché (10 filas; la de ejemplo, con
    28 regiones). El segundo, con los mismos candidatos, no reescribe ninguna
    fila, así que no llama a TMDB
  - Con el cupo por minuto lleno: 429 en 145 ms, sin llegar a embeddings ni a
    DeepSeek, con `Retry-After: 42` y «Vas muy deprisa. Espera 42 segundos…»
  - Con sesión (usuario de prueba de la Admin API, borrado al terminar): crea y
    continúa la conversación sin repetir título, 404 con un id inexistente, 400
    con otro modo, y cuenta en `user:<id>`. Sin sesión y con
    `conversation_id`, 401

Medido en la app, desde local y en caliente, 5 mensajes nuevos cada uno dos veces:

| Paso | Sin caché | Con caché |
|---|---|---|
| `hit_rate_limit` | 112–130 ms | igual |
| Plataformas | 298–605 ms (≈120 de leer la caché + ≈190 de TMDB) | 117–135 ms |
| Primer byte | 1,5–3,0 s, mediana 1,9 | 1,1–2,0 s, mediana 1,3 |

Desde local, cada viaje a Supabase (Irlanda) cuesta unos 120 ms: acertar en la
caché ahorra unos 70 ms frente a llamar a TMDB, y fallar cuesta unos 120 ms más.
Solo compensa en latencia con más de un 60 % de aciertos, o con las funciones de
Vercel cerca de Supabase (Fase 6). Lo que sí da siempre es el respaldo cuando
TMDB no responde. La diferencia de primer byte de la tabla es mayor que la de
plataformas porque el segundo envío repite el mensaje, y la búsqueda (y quizá
DeepSeek) van más rápidas con lo mismo

### Cierre: endpoints y mejoras

- [x] **`POST /api/search`** (`src/pages/api/search.ts`): la misma búsqueda que
      ve Umber, sin el modelo, con similitud, `autumn_score` y `rank_score` de
      cada resultado. Cuerpo `{ query, type?, limit? }` (hasta 30). Rate limit
      propio: 20 por minuto y 300 al día sin sesión, 30 y 1.000 con ella
- [x] **`GET /api/tmdb?content_id=…&region=…`** (`src/pages/api/tmdb.ts`):
      plataformas de un título del corpus, por la misma caché que el chat. Sin
      `region`, la de `Accept-Language`. Probado: 851 ms la primera vez, 258 ms
      en otra región (sale de la caché) y 152 ms con la región de la cabecera;
      404 fuera del corpus y 400 con un id o una región mal formados
- [x] **El idioma de la respuesta se decide en el servidor**
      (`detectMessageLanguage` en `src/lib/locale.ts`, `replyLanguage` en
      `src/lib/chat.ts`). Al repetir las pruebas, **los 2 mensajes en inglés de 14
      recibían la respuesta en español**, contra lo que esta fase daba por
      comprobado. Con el cambio, los dos contestan en inglés
- [x] **Candidatos en el idioma de la respuesta**: título y sinopsis en inglés
      para quien escribe en inglés, y la ficha con el mismo título que ha leído.
      El chat reconoce el título en cualquiera de los dos idiomas. Necesita la
      migración `20260930180000`: `search_content` devuelve ahora `title_en` y
      `synopsis_en`, lo que además quita la consulta extra de las sinopsis que
      faltaban
- [x] **Guardar sin perder turnos**: `append_conversation_messages` (migración
      `20260930180100`) añade en un solo UPDATE, con RLS del usuario. En PGlite:
      A añade, B recibe `false` sin tocar nada, lo que no es un array se
      rechaza, `anon` no puede llamarla
- [x] **«de la lista»**: no se reproduce. 0 de 14 respuestas provocadas (títulos
      que no están, «hola», «¿qué opciones tienes?», «dame tres», peticiones que
      nada cumple) nombran la lista, los candidatos o el catálogo, ni antes ni
      después de los cambios. Se niega con naturalidad («Interstellar no la tengo,
      pero…»). No se toca la regla de `system.md`
- [x] `parseText`, `isRecord`, `REGION_PATTERN` y `readClientAddress` pasan a
      `src/lib/api.ts`: los comparten el chat y la búsqueda
- [x] Rate limiting por ámbitos (`RATE_LIMITS` en `src/lib/rate-limit.ts`): cada
      endpoint cuenta aparte, con claves `chat:…` y `search:…`

### Conversación guiada: Umber pregunta, busca y saca otra (2026-10-01)

Decisión de producto: Umber no busca con cada mensaje, sino que conversa como un
cinéfilo. Pregunta para entender el ánimo, **decide él cuándo buscar** y busca
con **un resumen que escribe él**, no con los mensajes tal cual. Reglas en
`src/lib/turns.ts`:

1. **De 2 a 4 preguntas antes de buscar.** Al principio eran de 1 a 3, pero
   probándolo decidía demasiado pronto: con una pregunta recomendaba a ciegas.
   Una de las preguntas puede ser la popularidad (algo conocido o algo menos
   visto). El corpus no guarda popularidad, así que ese criterio lo aplica el
   modelo al elegir entre los candidatos, no la búsqueda. Si la persona se
   enrolla, Umber la lleva a cerrar («¿te busco algo así?»)
2. **Busca con `buscar_titulos(resumen)`**, una herramienta que DeepSeek llama
   él mismo. El resumen va en inglés (el corpus está vectorizado en inglés) y
   dice en positivo lo que no quiere: «nada de terror» pasa a «something calm»
3. **«Dame otra»** saca la siguiente de los 10 candidatos de esa búsqueda, sin
   volver a buscar, hasta agotarlos. Al acabarse, o si cambia el ánimo, busca
   de nuevo

- [x] **El servidor hace cumplir las reglas** con `tool_choice`, no el modelo:
      `none` hasta haber hecho dos preguntas (no puede buscar), `required` con 4
      preguntas seguidas (tiene que buscar), `auto` el resto
- [x] **El estado viaja en los mensajes de Umber**: `search` (resumen y los 10
      candidatos con su similitud) y `recommendation_ids`. Con sesión, en
      Supabase; sin ella, el navegador lo recibe en `done` y lo devuelve en el
      historial. Los candidatos se vuelven a leer de la base por id
      (`loadCandidates`), así que un id falso del navegador no llega a nada
- [x] ~~**Si la búsqueda es lo primero que hace, ocurre antes de responder**: un
      fallo del buscador sigue llegando con su código HTTP~~ Sustituido el
      2026-10-03: la búsqueda va con el stream abierto, detrás de un evento
      `searching` (ver Decisiones)
- [x] **Preámbulos fuera**: antes de buscar, Umber escribía a veces «Déjame ver
      qué tengo» y la recomendación iba pegada detrás (4 de 6 búsquedas). Regla
      en `system.md` y, además, el servidor retiene los primeros 280
      caracteres: si detrás llega la búsqueda, se descartan. Después, 0 de 4
- [x] Si Umber nombra en negrita un título que no viene de una búsqueda, queda
      en el log. En todas las pruebas: 0
- [x] La consulta de antes (los tres últimos mensajes de la persona) queda de
      respaldo, por si el resumen del modelo no se puede leer
- [x] Probado con 11 conversaciones por la API y 7 de 7 comprobaciones en
      Chromium (con las reglas de 1 a 3 preguntas; las de 2 a 4 están sin
      volver a medir):
  - Petición clara, melancolía, alguien que se enrolla, una negación, en
    inglés y de series: entre 1 y 3 preguntas y una recomendación que encaja
  - Siempre vago («No sé», «Me da igual»): 3 preguntas y a la cuarta busca
  - Agotar los candidatos: 10 «otra» sin buscar y luego una búsqueda nueva; 11
    recomendaciones, ninguna repetida
  - Cambio de ánimo tras recomendar («mejor algo alegre»): busca de nuevo
  - Con sesión, al recargar la conversación: las fichas vuelven, y «otra» sale
    de los candidatos guardados

Primer byte, medido desde local con los embeddings en Cloudflare:

| Turno | Primer byte | Qué hay detrás |
|---|---|---|
| Pregunta | 0,9–1,2 s | Solo DeepSeek. Se envía entera: cabe en los 280 retenidos |
| Búsqueda | 2,7–8,2 s, casi siempre 3–4,5 | Resumen de DeepSeek, embedding en Cloudflare, búsqueda, plataformas y segunda llamada |
| «Otra» | 1,3–1,8 s | Candidatos de la base por id, plataformas por la caché y DeepSeek |

## Pendiente

Nada. Las migraciones `20260930180000` y `20260930180100` están aplicadas y
verificadas:

- [x] `npm run db:verify` 32/32: `search_content` devuelve `title_en` y
      `synopsis_en`; 10 appends a la vez dejan 11 mensajes; `anon` no puede
      llamar a la función
- [x] `npm run db:verify-rls` 23/23: A añade a su conversación, B no puede
- [x] De extremo a extremo: en inglés, respuesta y ficha con el título inglés
      (*The Godfather*, *The Garden of Words*, *Gilmore Girls*); en español, en
      español (*El jardín de las palabras*). Con sesión, crear y continuar la
      conversación, ya con `append_conversation_messages`, sin repetir título.
      `/api/search` devuelve los dos títulos y las tres puntuaciones

Visto al cerrar, para la Fase 6: pedir un título por su nombre en español
(«¿Tienes El padrino?») no lo encuentra, aunque está en el corpus y en inglés sí
sale. El texto vectorizado de cada título solo lleva el título inglés.

## Decisiones tomadas

| Decisión | Motivo |
|---|---|
| Streaming siempre en el chat, sin variante no-streaming | Regla de `CLAUDE.md`. `complete()` existe solo para clasificación y extracción internas |
| El historial se guarda con el cliente del usuario, no con la secret key | Que RLS sea quien garantice el aislamiento, en vez de confiar en que el código filtre bien por `user_id` |
| **El chat no razona** en `movie` y `tv`; `weekend` y `month` podrán activarlo cuando se construyan, con más `max_tokens` | `deepseek-flash` razona por defecto y esos tokens cuentan contra `max_tokens`. Medido con `system.md`, la plantilla rellena con 10 candidatos reales de `search_content`, streaming y temperatura 0.8; 3 mensajes × 2 repeticiones por configuración. **Sin razonar, 600**: primera palabra en 0,6–0,9 s, 6/6 completas. **Razonando, 600** (lo que hacía el código): 2 de 6 respuestas vacías, las dos de series, con los 600 tokens gastados en pensar. **Razonando, 3.000**: primera palabra en 1,2–6,3 s (3 de 6 por encima de los 2 s que pide esta fase), entre 83 y 1.017 tokens de razonamiento. En calidad no se vio diferencia: las tres eligen de la lista y títulos parecidos. La tarea (elegir uno de 10 candidatos ya filtrados) no necesita pensar; planificar varios días sí puede |
| **`EMBEDDING_TASK` sin «autumnal»**: *«Given a description of how a viewer feels or what they feel like watching, retrieve a film or series whose tone and story match that mood»*. Resuelve la pregunta 2 de la Fase 3 | Tres instrucciones comparadas con 12 consultas de ánimo y 8 ajenas al cine. **La anterior**: 14 de 120 resultados con «otoño» o una estación en el título; un «asdfgh» (0,502) superaba la mediana de las consultas buenas (0,498). **Esta**: 0 de 120, y los mensajes ajenos bajan a 0,39 de mediana frente a 0,47 de las buenas. Una variante que pedía lo que «le sentaría bien» acertaba un poco mejor con «cansado del trabajo, algo ligero», pero volvía a traer títulos estacionales y separaba peor. Sigue habiendo coincidencias literales («buena fotografía» trae películas sobre fotógrafos): elegir entre los 10 es trabajo del modelo |
| **Suelo de similitud de 0,30**, no un umbral de «encaja» | Con este modelo la similitud no separa «nada encaja» de «encaja flojo». En películas, lo bueno cae entre 0,40 y 0,55; pero en series, que son 500, *«tarde de domingo, algo tranquilo»* se queda en 0,36 y *«buena fotografía, lento»* en 0,32, por debajo de «hola» (0,39). Cualquier umbral que quitara los saludos dejaría sin candidatos peticiones legítimas de series. El suelo solo quita ruido; ante un saludo, Umber pregunta (probado) |
| **El suelo se aplica en TypeScript; `search_content` recibe `min_score = -1`** | Con un umbral que pocas filas superan, la búsqueda iterativa (`strict_order`) sigue recorriendo el índice para completar el `LIMIT`. Medido con 0,99 y sin filtro de tipo: la mediana fue de 119 ms, pero la más lenta de 20 llamadas tardó 4,3 s, y la del chat llegó al timeout del rol `anon`. Sin umbral, el recorrido para en cuanto tiene las filas; como vienen ordenadas por similitud, filtrar después da el mismo resultado |
| **Reordenado: 30 candidatos, `similitud + 0,2 × autumn_score`, 10 al modelo** (0,2 desde el 2026-09-30) | Con 0,1, en 8 consultas cambiaban entre 0 y 5 de los 10 primeros, y entraban títulos del 11.º al 26.º con score alto. Se quedó en 0,1 porque el score de una pasada tenía ruido de ±0,1 a ±0,4. Con la media de tres y el corpus repuntuado, en 12 consultas: con 0,2 cambian entre 0 y 3 de los 10 primeros, su otoño medio sube de 0,58 a 0,61 y la similitud solo baja de 0,437 a 0,434. En «quiero pasar miedo» entran las dos *Noche de miedo* (0,89 y 0,88) y sale *Llega de noche* (0,40). Con 0,3 apenas se gana más (0,62) |
| **10 candidatos al modelo**. Resuelve la antigua pregunta 1 | Medido con 15 en 16 mensajes (12 de películas, 4 de series): Umber eligió 9 veces entre los 5 primeros, 6 entre el 6.º y el 10.º, y 1 más abajo (*El jardín de las palabras*, el 12.º). Usa toda la lista, así que menos le quitaría opciones; más le da una elección mejor 1 de cada 16 veces, a cambio de un 50 % más de candidatos en el prompt |
| **`autumn_score` promediado de tres pasadas**. Resuelve la antigua pregunta 2 | Hecho en la Fase 3 junto con el criterio nuevo (otoño antes que Halloween): ver [Repuntuación](fase-3-seed-corpus.md#repuntuación-2026-09-30) |
| ~~**La consulta son los tres últimos mensajes del usuario**~~ Sustituida el 2026-10-01 por el resumen del modelo; queda de respaldo si el resumen no se puede leer | «Dame otra» o «algo más alegre» no dicen nada solos. Probado: tras *«está lloviendo y estoy melancólico»*, «dame otra» sigue en ese ánimo, y «que me anime» lo desplaza sin perderlo. El coste: si alguien cambia de tema de golpe, los mensajes anteriores diluyen la búsqueda durante dos turnos |
| **Lo ya recomendado se quita de los candidatos**, no solo se lista en el prompt | Si el título sigue entre los candidatos, que no se repita depende de que el modelo obedezca. Se reconoce por el formato que pide `system.md`, **Título** (año), y el año desempata títulos repetidos (*La niebla* película y serie) |
| **SSE con eventos tipados**, y en `done` las fichas de lo recomendado | La Fase 5 tiene que pintar la ficha (póster, plataformas, id para favoritos). Con solo texto tendría que adivinar el título leyendo la respuesta. El servidor ya tiene los candidatos y sabe cuál ha nombrado Umber |
| ~~Todo lo que puede fallar antes del primer token falla antes de responder~~ Sustituida el 2026-10-03: **la búsqueda va con el stream abierto, detrás de un evento `searching`**. Lo de antes de DeepSeek (validar, rate limit, historial, abrir la primera llamada) sigue fallando con su código HTTP | Era razonable con el servidor local de embeddings (primer byte de 1,0 a 1,7 s), pero con Cloudflare la persona esperaba unos 6 s sin respuesta HTTP ni más aviso que «Pensando…». Medido en local contra Cloudflare: `searching` a los 1,8 s, primer texto a los 6,2 s; en el navegador, «Buscando títulos que encajen…» de 1,5 a 4,3 s. El cliente ya trataba igual un error en JSON que uno dentro del stream, así que no pierde nada; un script que mire solo el código HTTP sí tiene que leer el evento `error` |
| **Sin sesión, el historial viaja en cada petición desde la memoria del cliente**; con sesión y `conversation_id`, manda Supabase | Es la primera opción de la antigua pregunta 1: cumple a la vez «no `localStorage`» y «guardar si está autenticado». El endpoint no cambia si la Fase 5 activa el inicio de sesión anónimo de Supabase: esos usuarios traen JWT y se guardan como cualquier otro. Por eso la pregunta pasa a la Fase 5 |
| Al crear una conversación con sesión, se guarda también el historial que traía el cliente | Quien inicia sesión a mitad de charla no pierde lo hablado |
| Se guarda solo si la respuesta termina | Si el cliente se va, no hay respuesta entera. Si guardar falla, `done` llega con `conversation_id: null` y el error va al log: la persona ya ha leído la respuesta |
| El token llega en `Authorization: Bearer`, y se verifica con `getClaims` | No prejuzga la pregunta de cookies o cliente de la Fase 5: si gana SSR con cookies, se añade en `src/lib/auth.ts` y el endpoint no cambia. `getClaims` verifica la firma en local con las claves asimétricas del proyecto |
| El mensaje del usuario va citado línea a línea con `> `, y la plantilla se rellena en una sola pasada | Un «## Candidatos del corpus» escrito por el usuario queda dentro de la cita, y un `{{candidates}}` en el mensaje no se sustituye |
| La respuesta va en el idioma del mensaje, no en el de la interfaz | Con «Idioma de respuesta: es» en la plantilla, un mensaje en inglés recibía la respuesta en español, contra la regla de `system.md`. `{{locale}}` pasa a ser el idioma de la interfaz, y la instrucción de escribir en el idioma de la persona va al final de la plantilla, que es lo que el modelo más respeta |
| Umber no nombra la lista de candidatos | Al negarse a recomendar *Titanic* explicaba que «no está en la lista de candidatos que tengo delante». Nueva regla en `system.md` y recordatorio en la plantilla |
| **Caché de TMDB en una tabla aparte** (`platforms_cache`), no en columnas de `content`. Resuelve la antigua pregunta 3 | El corpus solo lo escribe el seed: con columnas, la app necesitaría escribir en la tabla del vector y del índice HNSW, y un fallo de caché podría estropear un título. Aparte, cada fila caduca sola y cae en cascada si el título sale del corpus. **Ojo**: se esperaba ahorrar 150–330 ms por mensaje, y desde local no es así (ver la tabla de Hecho). TMDB en caliente tarda unos 190 ms y leer la caché, unos 120: ahorra unos 70 ms al acertar y cuesta 120 al fallar. Se queda por el respaldo cuando TMDB falla y porque en Vercel, cerca de Supabase, leerla debería costar mucho menos. Si en producción no compensa, quitarla es volver a llamar a `fetchPlatformsByRegion` |
| Se cachean **todas las regiones** de un título, ya normalizadas, en una fila | TMDB manda todas las regiones en la misma respuesta: guardarlas no cuesta ninguna llamada más, y quien pregunta desde otra región tampoco llama a TMDB. Normalizadas y no crudas: es lo único que usa la app y ocupa una fracción. Si cambia la normalización, la caché tarda 3 días en ponerse al día |
| **3 días de caducidad**; si TMDB falla, vale la entrada caducada | Las plataformas cambian cada pocas semanas, casi siempre a fin de mes. Con poco tráfico, una caducidad de horas apenas acertaría. Más tiempo haría que Umber anunciara plataformas que ya no lo tienen. Una lista de hace unos días es mejor que ninguna |
| La caché y el rate limiting van con la secret key; sus tablas no tienen políticas y se les retiran los permisos de `anon` y `authenticated` | No son datos de ningún usuario, y `rate_limits` guarda IPs. Con `hit_rate_limit` abierta a la publishable key, cualquiera podría gastar el cupo de otra IP |
| **Rate limiting en una tabla de Supabase** (`rate_limits`). Resuelve la antigua pregunta 4 | Supabase ya está, sin otro proveedor. Cuesta una llamada más por mensaje, antes de las que cuestan dinero: 112–130 ms medidos en el chat desde local. En una conversación guardada no suma, porque va a la vez que su lectura. El firewall de Vercel limita solo por IP y sin distinguir sesiones |
| Ventanas fijas, límite corto y diario en una sola llamada | Una fila por ventana y un upsert atómico, sin carreras. En el cambio de ventana caben hasta el doble de peticiones seguidas, que para frenar abusos da igual |
| **Límites**: 8 por minuto; 300 al día con sesión y 60 sin ella | Cada respuesta tarda varios segundos en llegar, así que nadie escribe ocho por minuto a mano. El diario es el techo del gasto por persona. Más bajo sin sesión porque cambiar de IP es gratis y crear una cuenta exige confirmar un email; no más bajo porque detrás de una IP puede haber varias personas (una oficina, el CGNAT de un operador móvil). El día es de UTC |
| Sin sesión se cuenta por IP; **una IPv6, por su /64** | Un proveedor asigna un /64 a cada conexión, y dentro de él cambiar de dirección es gratis: por dirección, el límite no pararía nada. La IP es la de `clientAddress`, que en Vercel sale de `x-forwarded-for`, y esa cabecera la escribe su proxy, no el cliente |
| **Si el contador falla, el chat también** (502) | Sin límite, el endpoint que cuesta dinero quedaría abierto sin que nadie se enterase. La búsqueda depende de la misma base, así que no añade una caída que no hubiera ya |
| **`/api/tmdb` acotado a plataformas de títulos del corpus**, por `content_id`, no un proxy de rutas de TMDB | Un proxy libre dejaría usar nuestro token para cualquier cosa. Es lo único de TMDB que usa la app (el póster sale del corpus), y así pasa por la caché: cada título llama a TMDB como mucho una vez cada tres días. `Cache-Control` público de un día en la CDN, salvo si TMDB no respondió |
| **`/api/search` público, con rate limit propio** | Sirve para depurar el chat desde fuera, y el día que la interfaz tenga buscador ya está. No gasta DeepSeek, pero sí el servicio de embeddings, que es nuestro. `scripts/seed/search.py` sigue para depurar el corpus sin reordenar |
| **El idioma de la respuesta lo decide el servidor**, con una heurística de palabras frecuentes, y no el modelo | Medido con 10 mensajes en inglés y 10 en español. **Dejándolo al modelo**, con los dos títulos en cada candidato («El padrino / The Godfather») y la instrucción de usar el del idioma de la persona: **11 de 20**, y 9 de los 10 en inglés recibieron la respuesta en español («Sí, **The Godfather** (1972) la tengo…»). El modelo sabe en qué idioma le escriben, pero con 2.000 palabras de contexto en español delante no lo obedece. **Con el detector: 20 de 20, dos veces.** Además, el servidor necesita el idioma antes de llamar al modelo, para elegir el título y la sinopsis de cada candidato. Solo hay que distinguir español de inglés, y basta contar palabras que solo son de uno. Si el mensaje no lo deja claro («ok», «Interstellar»), vale el de los anteriores y después el de la interfaz |
| **Los candidatos llegan en el idioma de la respuesta** (título y sinopsis), y el chat reconoce los dos títulos | El modelo copia el título que ve: con el español delante, escribía *El padrino* en una respuesta en inglés. La ficha usa el mismo título que la respuesta. Las etiquetas del bloque (géneros, «similitud») siguen en español: no han hecho falta |
| **El append de mensajes, en una función SQL con RLS del usuario** | Leer, concatenar y reescribir perdía un turno con dos peticiones a la vez. En un UPDATE, la segunda espera al bloqueo de la fila y concatena sobre lo ya guardado. SECURITY INVOKER: sigue decidiendo la política de UPDATE de `conversations` |
| **Conversación guiada: Umber pregunta de 2 a 4 veces (antes, de 1 a 3: decidía demasiado pronto), busca cuando lo decide, y «otra» sale de los mismos 10 candidatos** | Decisión de producto. Se parece más a un cinéfilo que te conoce que a un buscador. Las preguntas salen rápido (~1 s) porque no buscan nada; buscar con un resumen interpreta bien negaciones, cambios de tema y «algo más alegre», que juntando mensajes no se entendían. El precio: el turno que busca hace dos llamadas a DeepSeek |
| **Las reglas las hace cumplir el servidor con `tool_choice`**, no el prompt | El modelo puede saltarse una instrucción; `none` y `required` no. Probado: con respuestas siempre vagas y el tope de 3 de entonces, buscó justo a la cuarta |
| **El estado de la conversación vive en los propios mensajes** (`search`, `recommendation_ids`), no en una tabla | Sin migración, y vale igual con sesión (Supabase) que sin ella (el navegador lo devuelve). Del historial salen las preguntas seguidas, la última búsqueda y los candidatos que quedan |
| **Resumen en inglés** | El corpus está vectorizado en inglés. Qwen3 entiende la búsqueda en español, pero así la consulta se parece más a los documentos |
| Se retienen los primeros 280 caracteres de cada respuesta | Es la forma de quitar un preámbulo («Déjame ver») que el modelo escribe antes de buscar: con la regla en el prompt no bastaba para garantizarlo. Cuesta unas décimas en las preguntas, que se envían enteras; una recomendación empieza a llegar en cuanto pasa de ahí |

## Preguntas abiertas

Ninguna. Las cuatro que hubo están resueltas en Decisiones: 1, cuántos
candidatos (10); 2, promediar `autumn_score` (tres pasadas); 3, dónde se cachea
TMDB (`platforms_cache`); 4, dónde se cuenta el rate limiting (`rate_limits`).

## Verificación

- [x] Un mensaje real devuelve un stream que empieza a llegar en menos de dos
      segundos: entre 1,0 y 1,7 s en caliente, en local. La primera petición tras
      arrancar el servidor de desarrollo tardó 3,4 s. **Con rate limiting y caché
      (2026-09-30), justo en el límite**: mediana de 1,9 s sin caché (una de cinco
      pasó de 3 s) y de 1,3 s con ella. Desde local, cada viaje a Supabase suma
      unos 120 ms; en Vercel depende de su región (Fase 6). **Con los embeddings en Cloudflare
      (Fase 6), ya no se cumple**: mediana de 5,0 s con mensajes nuevos. Aceptado
      a cambio de no mantener ningún servidor
- [x] Umber nunca menciona un título que no estuviera en los candidatos: probado
      con *Titanic* inyectado en el mensaje y con *Interstellar*, que no está en el
      corpus
- [x] Con el corpus vacío o sin coincidencias, pide otro ángulo en vez de
      inventar
- [x] La conversación aparece en `conversations` con el `user_id` correcto, y un
      segundo usuario no la ve: probado con dos usuarios reales, 13 de 13
      comprobaciones (crear, continuar, no repetir, 404 para el otro usuario, modo
      distinto, historial del cliente al iniciar sesión)
