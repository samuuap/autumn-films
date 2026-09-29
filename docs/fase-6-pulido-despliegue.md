# Fase 6 — Pulido y despliegue

**Estado:** ⏳ Pendiente
**Depende de:** [Fase 5](fase-5-frontend.md) ⏳
**Actualizado:** 2026-09-29

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
- [ ] Navegación completa por teclado y `aria-live` en el stream del chat, para
      que un lector de pantalla anuncie la respuesta de Umber
- [ ] Textos alternativos en pósters y backdrops

### i18n

- [ ] Español e inglés. `src/lib/types.ts` ya tiene `LOCALES`, `Locale` y
      `DEFAULT_LOCALE`
- [ ] Umber ya responde en el idioma de la persona por instrucción de
      `system.md`; falta traducir la interfaz
- [ ] Usar `title_en` y `synopsis_en` del corpus cuando el idioma sea inglés
- [ ] Ajustar la región de streaming de TMDB según el idioma, en vez de `ES` fijo

### Despliegue

- [ ] Proyecto de Vercel conectado al repositorio
- [ ] Variables de entorno en producción. El build falla si falta alguna
      obligatoria, que es justo el comportamiento que queremos
- [ ] `PUBLIC_APP_URL` apuntando al dominio real
- [ ] **Servicio de embeddings en producción** — ver pregunta 1. Es el bloqueante
      real de esta fase
- [ ] Comprobar que el despliegue de vista previa de Vercel también alcanza ese
      servicio

### Operación

- [ ] Rate limiting en `/api/chat` si no se hizo en la
      [Fase 4](fase-4-api-chat.md)
- [ ] Alguna forma de ver los errores en producción, aunque sea los logs de
      Vercel
- [ ] Vigilar el gasto de DeepSeek. `deepseek-flash` es barato, pero el coste va
      por conversación y no tiene techo. El endpoint `/user/balance` de DeepSeek
      sirve para consultarlo por API. A 2026-09-29 la cuenta tiene 1,16 USD:
      suficiente para desarrollo, no para abrir al público

## Decisiones tomadas

| Decisión | Motivo |
|---|---|
| `output: 'server'` con adaptador de Vercel | El chat necesita streaming en servidor. La portada podría prerenderizarse más adelante si interesa |
| Fuentes autoalojadas | Sin terceros, sin salto de fuente y una petición externa menos |

## Preguntas abiertas

**1. ¿Dónde corre el servicio de embeddings en producción?**
Es la decisión con más consecuencias que queda pendiente. El modelo no cabe en
una función serverless de Vercel, así que `/api/chat` tiene que llamar a un
servicio externo alcanzable. Opciones:
- Contenedor propio en Fly.io, Railway o un VPS. Control total y coste fijo
  mensual; hay que mantenerlo y aguantar el arranque en frío si escala a cero
- Un proveedor que sirva Qwen3-Embedding por API. Cero mantenimiento, coste por
  llamada, y deja de ser «local» — que era parte del motivo de elegirlo
- Un modelo distinto y gestionado solo para producción. **Mala idea**: dos
  modelos de embeddings distintos producen vectores incompatibles entre sí, y el
  corpus está indexado con uno

El diseño ya absorbe cualquiera de las dos primeras cambiando `EMBEDDINGS_URL`,
porque hablamos con el servicio por la API de embeddings de OpenAI. Para la
primera, `scripts/embeddings/server.py` ya sirve como contenedor.

Aviso de la Fase 3: incluso con el **mismo** modelo, el servicio de producción
tiene que dar los mismos vectores que el que indexó el corpus. En local, cargar
el modelo en bfloat16 en vez de float32 ya los desviaba. Antes de apuntar
`EMBEDDINGS_URL` a otro servicio, comparar su salida con la matriz de referencia
de la ficha del modelo y con unos cuantos vectores del corpus cargado.

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
