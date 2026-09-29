# Fase 4 — API del chat

**Estado:** ⏳ Pendiente
**Depende de:** [Fase 3](fase-3-seed-corpus.md) ✅ — sin corpus no hay candidatos
**Actualizado:** 2026-09-29

## Objetivo

Montar el flujo completo del chat en servidor: del mensaje del usuario a un
stream de texto de Umber, pasando por vectorización, búsqueda semántica y
enriquecimiento con TMDB.

## Hecho

Nada todavía. `src/pages/api/` está creado y vacío. Las piezas que consume esta
fase ya existen: `embedQuery()`, `streamChatText()`, los clientes de Supabase y
TMDB, y las dos plantillas de `src/prompts/`.

## Pendiente

### `POST /api/chat`

- [ ] Validar el input antes de que llegue al LLM: modo válido
      (`isAvailableChatMode`), longitud máxima del mensaje, historial acotado
- [ ] `embedQuery()` sobre el mensaje del usuario — con instrucción, que es lo
      que distingue una consulta de un documento
- [ ] `search_content` con `content_type` según el modo (`movie` → `'movie'`,
      `tv` → `'tv'`)
- [ ] **Bajar `min_score`.** El 0.5 por defecto de la función es demasiado alto
      para este modelo: en las búsquedas de control de la Fase 3, resultados
      buenos caen entre 0,45 y 0,59, y con 0.5 la consulta *«está lloviendo y
      estoy melancólico»* se quedaría con 2 candidatos de 10. Medir un umbral
      que separe «nada encaja» de «encaja flojo»; `search.py` pide sin umbral
      para ver los valores reales
- [ ] **Reordenar con `autumn_score`**, que es lo que se decidió en la Fase 3
      (filtrar y ordenar): pedir más candidatos de los que se pasan al modelo y
      combinar similitud y `autumn_score`. El score tiene ruido en la franja
      media (pregunta 1 de la Fase 3), así que su peso debería ser moderado
- [ ] **Revisar `EMBEDDING_TASK`.** Dice «retrieve the autumnal film», pero todo
      el corpus ya es otoñal, así que esa palabra no filtra nada y sesga hacia
      títulos con «otoño» en el nombre (pregunta 2 de la Fase 3). Cambiarla no
      obliga a reindexar, pero sí a cambiar también `scripts/seed/common.py`
- [ ] Enriquecer los candidatos con TMDB (`append_to_response=watch/providers`)
- [ ] Renderizar `src/prompts/user-context.md` sustituyendo las `{{variables}}`
      que el propio archivo documenta
- [ ] Llamada a `deepseek-flash` con `system.md` + contexto + historial
- [ ] **Decidir si el chat razona.** `deepseek-flash` razona por defecto y esos
      tokens cuentan contra `max_tokens`. Medido en la Fase 3: 463 tokens de
      razonamiento para puntuar **un** título, y con 25 títulos y
      `max_tokens: 1000` la respuesta llegó vacía. Hoy `streamChat` y `complete`
      en `src/lib/deepseek.ts` no lo desactivan, y con el tope de 600 el chat
      devolvería respuestas vacías o cortadas. Además, el razonamiento retrasa el
      primer token de texto, y la verificación de esta fase pide que el stream
      empiece antes de dos segundos. O se desactiva
      (`thinking: { type: 'disabled' }`) o se sube el tope y se asume la latencia
- [ ] Devolver el stream al cliente
- [ ] Guardar la conversación en Supabase con el cliente del usuario, para que
      RLS aplique — no con la secret key

### Casos que hay que resolver, no solo el camino feliz

- [ ] **Sin candidatos.** Si `search_content` no devuelve nada por encima de
      `min_score`, Umber tiene que pedir otro ángulo del ánimo, no inventarse un
      título. La regla ya está en `system.md`; hay que asegurar que el prompt
      recibe `(ninguno)` y no una lista vacía ambigua
- [ ] **No repetir recomendaciones.** La plantilla tiene
      `{{already_recommended}}`: hay que extraer del historial los títulos ya
      mencionados y pasarlos
- [ ] **El cliente abandona.** Cortar la generación con el `AbortSignal` que ya
      aceptan `streamChat` y `complete`, para no pagar tokens de una respuesta
      que nadie va a leer
- [ ] **El servicio de embeddings no responde.** Es una dependencia externa y en
      producción vive fuera de Vercel. Necesita un mensaje de error decente, no
      un 500 en crudo
- [ ] **Errores del proveedor.** La jerarquía de `src/lib/errors.ts` ya trae
      `status` por tipo de error: usarlo para el código HTTP de la respuesta

### Otros endpoints

- [ ] `POST /api/search` — búsqueda semántica suelta, útil para depurar el corpus
- [ ] `GET /api/tmdb` — proxy, porque el navegador no debe llamar a TMDB
- [ ] Caché de respuestas de TMDB en Supabase, como pide `CLAUDE.md`. Requiere
      decidir dónde: columnas nuevas en `content` o una tabla aparte con TTL
- [ ] Rate limiting en `/api/chat`. Es el endpoint que cuesta dinero por llamada

## Decisiones tomadas

| Decisión | Motivo |
|---|---|
| Streaming siempre en el chat, sin variante no-streaming | Regla de `CLAUDE.md`. `complete()` existe solo para clasificación y extracción internas |
| El historial se guarda con el cliente del usuario, no con la secret key | Que RLS sea quien garantice el aislamiento, en vez de confiar en que el código filtre bien por `user_id` |

## Preguntas abiertas

**1. ¿Qué historial ve un usuario sin cuenta?**
`CLAUDE.md` dice guardar la conversación «si está autenticado» y prohíbe
`localStorage` para el historial. Entre las dos reglas, un usuario anónimo se
queda sin historial ninguno: cada recarga empieza de cero, y Umber no puede
cumplir su propia regla de no repetir títulos. Opciones:
- Mantener el historial solo en memoria del cliente durante la sesión, sin
  persistir nada. Respeta ambas reglas, se pierde al recargar
- Crear la conversación en Supabase con `user_id NULL` y una cookie de sesión
  para reclamarla. Persiste, pero hay que decidir cuánto vive y cómo se limpia
- Exigir cuenta para chatear. Lo más simple, y la fricción más alta justo en la
  primera visita
- **Usar el inicio de sesión anónimo de Supabase.** Crea una fila real en
  `auth.users` sin pedir email, así que el usuario tiene `user_id` desde la
  primera visita: RLS funciona sin cambios, la conversación persiste, y más
  adelante se puede vincular un email a esa misma cuenta sin perder el
  historial. Es la opción que menos código especial necesita. Está
  **desactivado** en el proyecto (`anonymous_users: false`): se activa en
  Authentication → Sign In / Providers. A vigilar: genera un usuario por
  visitante, así que hay que pensar la limpieza de cuentas abandonadas

**2. ¿Cuántos candidatos se le pasan al modelo?**
`match_count` está en 10 por defecto. Más candidatos dan más margen de elección
pero gastan tokens de entrada y diluyen la atención del modelo sobre los buenos.
Hay que medirlo con el corpus real.

## Verificación

- Un mensaje real devuelve un stream que empieza a llegar en menos de dos
  segundos
- Umber nunca menciona un título que no estuviera en los candidatos
- Con el corpus vacío o sin coincidencias, pide otro ángulo en vez de inventar
- La conversación aparece en `conversations` con el `user_id` correcto, y un
  segundo usuario no la ve
