# Fase 3 — Seed del corpus

**Estado:** ⏳ Pendiente
**Depende de:** [Fase 2](fase-2-base-de-datos.md) ⏳ — hace falta el esquema creado
**Actualizado:** 2026-09-29

## Objetivo

Llenar `content` con ~5.000 películas y series de criterio otoñal, vectorizadas y
listas para búsqueda semántica. Es la fase que define qué puede recomendar Umber:
lo que no entre en el corpus, no existe para él.

## Hecho

Nada todavía. `scripts/seed/` está creado y vacío.

## Pendiente

### Infraestructura local

- [ ] Levantar el servicio de embeddings:
      ```bash
      docker run -p 8080:80 ghcr.io/huggingface/text-embeddings-inference:cpu-latest \
        --model-id Qwen/Qwen3-Embedding-0.6B
      ```
- [ ] `scripts/seed/requirements.txt`
- [ ] Nota: el Python del sistema es 3.9. Conviene un entorno virtual con una
      versión más reciente antes de instalar dependencias

### `fetch-tmdb.py`

- [ ] Descargar ~5.000 títulos según los criterios de la pregunta 1
- [ ] Traer `es-ES` y `en-US` en llamadas separadas, porque el esquema guarda
      `title`/`title_en` y `synopsis`/`synopsis_en`
- [ ] Traer `keywords` y `credits` (el director no viene en el detalle base)
- [ ] Respetar el rate limit de TMDB con reintentos y backoff
- [ ] Caché en `scripts/seed/data/` (ya ignorado en git) para poder reanudar sin
      volver a descargar. Con 5.000 títulos × varias llamadas cada uno, un corte
      a mitad sin caché significa empezar de cero

### `embed.py`

- [ ] Construir el texto a vectorizar (sinopsis + keywords + géneros) según la
      decisión de la pregunta 2
- [ ] Vectorizar **sin** instrucción: son documentos, no consultas. La
      instrucción solo va del lado de la consulta, en `/api/chat`
- [ ] Verificar que cada vector tiene 1024 dimensiones antes de escribirlo
- [ ] Lotes con reanudación: guardar los vectores en disco a medida que salen

### `load-db.py`

- [ ] Cargar con la secret key, que es la que se salta RLS
- [ ] `upsert` por `tmdb_id` para que reejecutar el script no duplique
- [ ] Cargar por lotes, no fila a fila
- [ ] Crear el índice vectorial **después** de la carga inicial: indexar antes
      obliga a mantener el índice durante la inserción y es más lento

### Cierre

- [ ] Contar filas y comprobar cuántas quedaron sin `embedding`, sin `director` o
      sin `synopsis`
- [ ] Búsquedas manuales de control: describir tres estados de ánimo distintos y
      mirar si los diez primeros resultados tienen sentido. Es la única forma
      real de saber si el corpus y la vectorización sirven

## Decisiones tomadas

| Decisión | Motivo |
|---|---|
| El texto canónico que se vectoriza se construye en Python, no en TypeScript | Evita tener la misma lógica en dos lenguajes. El lado TypeScript solo vectoriza consultas, nunca documentos |

## Preguntas abiertas

**1. ¿Cómo se define «otoñal» y cómo se calcula `autumn_score`?**
El esquema tiene la columna pero nada dice cómo se rellena, y es la decisión que
más determina el carácter del producto. Posibilidades:
- Heurística sobre géneros, keywords de TMDB y década. Barato, reproducible y
  fácil de ajustar, pero tosco
- Puntuar cada título con `deepseek-flash` a temperatura 0.1. Más fino, pero son
  5.000 llamadas y el resultado no es reproducible entre ejecuciones
- Mixto: heurística para preseleccionar un universo amplio y el LLM solo para
  puntuar los que pasan el filtro

Relacionado: ¿`autumn_score` sirve para **filtrar** el corpus al descargarlo, o
para **ordenar** dentro de los resultados de la búsqueda? No es lo mismo.

**2. ¿Vectorizamos la sinopsis española, la inglesa o ambas?**
Qwen3-Embedding es multilingüe y cross-lingüe, así que una consulta en español
puede recuperar un documento vectorizado en inglés. Pero no da igual:
- Solo español: coherente con el idioma principal, y las sinopsis en español de
  TMDB a veces están vacías o son peores
- Solo inglés: sinopsis más completas y consistentes, y el inglés es donde el
  modelo rinde mejor
- Ambas concatenadas: más contexto por título, riesgo de diluir el vector

Afecta a la calidad de la búsqueda en los dos idiomas de la
[Fase 6](fase-6-pulido-despliegue.md) y no se puede cambiar sin reindexar.

## Verificación

- `SELECT count(*) FROM content` cerca de 5.000, repartido entre `movie` y `tv`
- Ninguna fila con `embedding IS NULL`
- `search_content` con una consulta real devuelve títulos coherentes
- Reejecutar los tres scripts no duplica filas ni rompe nada
