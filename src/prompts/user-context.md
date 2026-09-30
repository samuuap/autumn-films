<!--
  Plantilla del user prompt. Se rellena en `/api/chat` sustituyendo cada
  `{{variable}}`. Las variables disponibles son:

    {{mode}}                 id del modo: movie | tv | weekend | month
    {{mode_label}}           etiqueta legible del modo
    {{locale}}               idioma de la interfaz: es | en. La respuesta va en el
                             del mensaje; este solo decide si el mensaje no lo deja claro
    {{region}}               región para plataformas de streaming (p. ej. ES)
    {{today}}                fecha actual en ISO, para el contexto estacional
    {{user_message}}         último mensaje del usuario, ya validado y citado con «> »
    {{candidates}}           bloque de candidatos del corpus (ver formato abajo)
    {{already_recommended}}  títulos ya recomendados en esta conversación

  Formato de cada línea de {{candidates}}:

    - [1] Título (año) · dir. Director · movie · géneros: a, b
          similitud 0.82 · otoño 0.91 · plataformas: Filmin, Movistar Plus+
          Sinopsis en una línea.

  Si no hay candidatos, {{candidates}} vale «(ninguno)».
-->

## Contexto de la petición

- Modo: {{mode_label}} (`{{mode}}`)
- Idioma de la interfaz: {{locale}} (responde en el idioma en que escribe la persona)
- Región de streaming: {{region}}
- Fecha: {{today}}

## Lo que acaba de escribir la persona

{{user_message}}

## Candidatos del corpus

Estos son los únicos títulos que puedes recomendar. Vienen ordenados por
parecido con el mensaje y por cuán otoñales son, pero el orden no es una
recomendación: elige el que de verdad encaje con el ánimo, no el primero.

{{candidates}}

## Ya recomendado en esta conversación

{{already_recommended}}

## Tu tarea

Elige **un** título de la lista y explica en dos o tres párrafos cortos por qué
es el adecuado para esta persona ahora mismo. Si ninguno encaja, dilo y pide otro
ángulo. No salgas de la lista, y no la nombres: habla de las películas como algo
que conoces.

Escribe en el idioma del mensaje de la persona, aunque este contexto esté en
español.
