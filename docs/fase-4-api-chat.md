# Fase 4 — API del chat

**Estado:** 🔄 En curso
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
      `similitud + 0,1 × autumn_score` y pasan 10 al modelo (`src/lib/search.ts`)
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
      cliente de embeddings tiene ahora 10 s de timeout y un reintento: el SDK
      espera 10 minutos por defecto
- [x] **Errores del proveedor.** El código HTTP sale de `status` de cada error de
      `src/lib/errors.ts`, que suma `AuthError` (401) y `NotFoundError` (404). La
      persona ve un mensaje redactado para ella; el detalle (URLs, respuesta del
      proveedor) se queda en el log
- [x] **Token de sesión inválido o caducado:** 401, no se trata como anónimo, para
      que el cliente renueve la sesión en vez de perder el historial
- [x] **Mensaje en otro idioma.** Contesta en el idioma del mensaje, aunque la
      interfaz esté en español (ver Decisiones)
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

## Pendiente

### Otros endpoints

- [ ] `POST /api/search` — búsqueda semántica suelta, útil para depurar el corpus.
      Ya puede reutilizar `searchCandidates()`
- [ ] `GET /api/tmdb` — proxy, porque el navegador no debe llamar a TMDB. Hoy
      ningún código del navegador lo necesita: las plataformas se piden en
      servidor y los pósters vienen de `image.tmdb.org`

### Mejoras vistas al probar

- [ ] De vez en cuando Umber aún dice «de la lista». Ya no la explica ni la
      nombra al negarse, que era lo grave; queda como matiz de prompt
- [ ] Una persona que escribe en inglés recibe el título en español
      (*Siempre queda el amor*): el corpus tiene `title_en`, pero
      `search_content` no lo devuelve. Encaja con la i18n de la Fase 6
- [ ] Guardar una conversación lee, concatena y reescribe el array: dos
      peticiones simultáneas sobre la misma conversación pueden perder un turno. Con
      una pestaña por conversación no pasa; si importa, una función SQL que haga el
      append

## Decisiones tomadas

| Decisión | Motivo |
|---|---|
| Streaming siempre en el chat, sin variante no-streaming | Regla de `CLAUDE.md`. `complete()` existe solo para clasificación y extracción internas |
| El historial se guarda con el cliente del usuario, no con la secret key | Que RLS sea quien garantice el aislamiento, en vez de confiar en que el código filtre bien por `user_id` |
| **El chat no razona** en `movie` y `tv`; `weekend` y `month` podrán activarlo cuando se construyan, con más `max_tokens` | `deepseek-flash` razona por defecto y esos tokens cuentan contra `max_tokens`. Medido con `system.md`, la plantilla rellena con 10 candidatos reales de `search_content`, streaming y temperatura 0.8; 3 mensajes × 2 repeticiones por configuración. **Sin razonar, 600**: primera palabra en 0,6–0,9 s, 6/6 completas. **Razonando, 600** (lo que hacía el código): 2 de 6 respuestas vacías, las dos de series, con los 600 tokens gastados en pensar. **Razonando, 3.000**: primera palabra en 1,2–6,3 s (3 de 6 por encima de los 2 s que pide esta fase), entre 83 y 1.017 tokens de razonamiento. En calidad no se vio diferencia: las tres eligen de la lista y títulos parecidos. La tarea (elegir uno de 10 candidatos ya filtrados) no necesita pensar; planificar varios días sí puede |
| **`EMBEDDING_TASK` sin «autumnal»**: *«Given a description of how a viewer feels or what they feel like watching, retrieve a film or series whose tone and story match that mood»*. Resuelve la pregunta 2 de la Fase 3 | Tres instrucciones comparadas con 12 consultas de ánimo y 8 ajenas al cine. **La anterior**: 14 de 120 resultados con «otoño» o una estación en el título; un «asdfgh» (0,502) superaba la mediana de las consultas buenas (0,498). **Esta**: 0 de 120, y los mensajes ajenos bajan a 0,39 de mediana frente a 0,47 de las buenas. Una variante que pedía lo que «le sentaría bien» acertaba un poco mejor con «cansado del trabajo, algo ligero», pero volvía a traer títulos estacionales y separaba peor. Sigue habiendo coincidencias literales («buena fotografía» trae películas sobre fotógrafos): elegir entre los 10 es trabajo del modelo |
| **Suelo de similitud de 0,30**, no un umbral de «encaja» | Con este modelo la similitud no separa «nada encaja» de «encaja flojo». En películas, lo bueno cae entre 0,40 y 0,55; pero en series, que son 500, *«tarde de domingo, algo tranquilo»* se queda en 0,36 y *«buena fotografía, lento»* en 0,32, por debajo de «hola» (0,39). Cualquier umbral que quitara los saludos dejaría sin candidatos peticiones legítimas de series. El suelo solo quita ruido; ante un saludo, Umber pregunta (probado) |
| **El suelo se aplica en TypeScript; `search_content` recibe `min_score = -1`** | Con un umbral que pocas filas superan, la búsqueda iterativa (`strict_order`) sigue recorriendo el índice para completar el `LIMIT`. Medido con 0,99 y sin filtro de tipo: la mediana fue de 119 ms, pero la más lenta de 20 llamadas tardó 4,3 s, y la del chat llegó al timeout del rol `anon`. Sin umbral, el recorrido para en cuanto tiene las filas; como vienen ordenadas por similitud, filtrar después da el mismo resultado |
| **Reordenado: 30 candidatos, `similitud + 0,1 × autumn_score`, 10 al modelo** | Con 0,1, en 8 consultas cambian entre 0 y 5 de los 10 primeros, y entran títulos del 11.º al 26.º con score alto (en «pasar miedo», *El club de medianoche*, 0,92). Con 0,2 el score empieza a pesar tanto como la similitud, y tiene ruido de ±0,1 a ±0,4 en la franja media (pregunta 1 de la Fase 3) |
| **La consulta son los tres últimos mensajes del usuario** | «Dame otra» o «algo más alegre» no dicen nada solos. Probado: tras *«está lloviendo y estoy melancólico»*, «dame otra» sigue en ese ánimo, y «que me anime» lo desplaza sin perderlo. El coste: si alguien cambia de tema de golpe, los mensajes anteriores diluyen la búsqueda durante dos turnos |
| **Lo ya recomendado se quita de los candidatos**, no solo se lista en el prompt | Si el título sigue entre los candidatos, que no se repita depende de que el modelo obedezca. Se reconoce por el formato que pide `system.md`, **Título** (año), y el año desempata títulos repetidos (*La niebla* película y serie) |
| **SSE con eventos tipados**, y en `done` las fichas de lo recomendado | La Fase 5 tiene que pintar la ficha (póster, plataformas, id para favoritos). Con solo texto tendría que adivinar el título leyendo la respuesta. El servidor ya tiene los candidatos y sabe cuál ha nombrado Umber |
| Todo lo que puede fallar antes del primer token falla antes de responder | Un 502 con JSON es más fácil de tratar en el cliente que un error dentro de un stream ya abierto. El precio es que el primer byte espera a la búsqueda y a TMDB: en caliente, entre 1,0 y 1,7 s (embedding y búsqueda 180–350 ms, TMDB 150–330 ms, apertura de DeepSeek unos 330 ms) |
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

## Preguntas abiertas

**1. ¿Cuántos candidatos se le pasan al modelo?**
Diez por defecto (`DEFAULT_CANDIDATE_COUNT`). Más candidatos dan más margen de
elección pero gastan tokens de entrada y diluyen la atención del modelo sobre los
buenos. Hay que medirlo con el corpus real.

**2. ¿Promediar `autumn_score`?** (pregunta 1 de la Fase 3)
Ya reordena con peso 0,1: el ruido de ±0,4 de la franja media se convierte en
±0,04 de orden, del orden de la distancia entre el primer y el décimo candidato.
No bloquea, pero decide en los márgenes.

Las antiguas preguntas 3 (dónde se cachea TMDB) y 4 (dónde se cuentan las
peticiones del rate limiting) están resueltas en Decisiones.

## Verificación

- [x] Un mensaje real devuelve un stream que empieza a llegar en menos de dos
      segundos: entre 1,0 y 1,7 s en caliente, en local. La primera petición tras
      arrancar el servidor de desarrollo tardó 3,4 s. **Con rate limiting y caché
      (2026-09-30), justo en el límite**: mediana de 1,9 s sin caché (una de cinco
      pasó de 3 s) y de 1,3 s con ella. Desde local, cada viaje a Supabase suma
      unos 120 ms; en Vercel depende de su región (Fase 6)
- [x] Umber nunca menciona un título que no estuviera en los candidatos: probado
      con *Titanic* inyectado en el mensaje y con *Interstellar*, que no está en el
      corpus
- [x] Con el corpus vacío o sin coincidencias, pide otro ángulo en vez de
      inventar
- [x] La conversación aparece en `conversations` con el `user_id` correcto, y un
      segundo usuario no la ve: probado con dos usuarios reales, 13 de 13
      comprobaciones (crear, continuar, no repetir, 404 para el otro usuario, modo
      distinto, historial del cliente al iniciar sesión)
