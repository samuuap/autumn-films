<!--
  Plantilla del user prompt. Se rellena en `/api/chat` sustituyendo cada
  `{{variable}}`. Las variables disponibles son:

    {{mode}}                 id del modo: movie | tv | weekend | month
    {{mode_label}}           etiqueta legible del modo
    {{reply_language}}       idioma de la respuesta: «español» o «inglés (English)».
                             El del mensaje, detectado en servidor; si no se sabe,
                             el de mensajes anteriores y luego el de la interfaz
    {{region}}               región para plataformas de streaming (p. ej. ES)
    {{today}}                fecha actual en ISO, para el contexto estacional
    {{user_message}}         último mensaje del usuario, ya validado y citado con «> »
    {{conversation_state}}   en qué punto está: preguntas hechas, última búsqueda,
                             candidatos que quedan (`describeState` en src/lib/chat.ts)
    {{candidates}}           los que le quedan de la última búsqueda (formato abajo),
                             «(aún no has buscado)» o «(no te queda ninguno)»
    {{already_recommended}}  títulos ya recomendados en esta conversación

  Formato de cada línea de {{candidates}}, con título y sinopsis en el idioma
  de la respuesta:

    - [1] Título (año) · dir. Director · movie · géneros: a, b
          similitud 0.82 · otoño 0.91 · plataformas: Filmin, Movistar Plus+
          Sinopsis en una línea.

  Cuando Umber busca, los candidatos nuevos no van aquí sino en el resultado
  de `buscar_titulos` (`formatSearchResult`), con el mismo formato.
-->

## Contexto de la petición

- Modo: {{mode_label}} (`{{mode}}`)
- Idioma de la respuesta: {{reply_language}}
- Región de streaming: {{region}}
- Fecha: {{today}}

## Lo que acaba de escribir la persona

{{user_message}}

## En qué punto está la conversación

{{conversation_state}}

## Candidatos que te quedan de tu última búsqueda

{{candidates}}

## Ya recomendado en esta conversación

{{already_recommended}}

## Tu tarea

Según el punto en que está la conversación, haz una de estas tres cosas:

- **Preguntar**: una sola pregunta corta para entender mejor su ánimo. Sin
  nombrar ninguna película.
- **Buscar**: llama a `buscar_titulos` con un resumen de su ánimo. Te devolverá
  los candidatos, y entonces recomiendas uno.
- **Recomendar** uno de los candidatos que te quedan, si pide otra: explica en
  dos o tres párrafos cortos por qué es el adecuado para esta persona ahora.

Solo puedes nombrar títulos que vengan de una búsqueda. No nombres la lista ni
la búsqueda: habla de las películas como algo que conoces.

Escribe toda la respuesta en {{reply_language}}, aunque este contexto esté en
español, y escribe los títulos tal como vienen en los candidatos.
