# Fase 3 — Seed del corpus

**Estado:** ✅ Completada
**Depende de:** [Fase 2](fase-2-base-de-datos.md) ✅
**Actualizado:** 2026-09-30 (corpus repuntuado: ver «Repuntuación»)

## Objetivo

Llenar `content` con ~5.000 películas y series de criterio otoñal, vectorizadas y
listas para búsqueda semántica. Es la fase que define qué puede recomendar Umber:
lo que no entre en el corpus, no existe para él.

## Hecho

### Infraestructura local

- [x] Entorno virtual con Python 3.12 en `.venv/`: el del sistema es 3.9
- [x] `scripts/embeddings/server.py` (`npm run embeddings`): Qwen3-Embedding con
      la API de embeddings de OpenAI, sobre sentence-transformers y MPS. No hay
      Docker en la máquina
- [x] Validado contra la matriz de similitud de la ficha del modelo: coincide en
      los cuatro decimales, las normas dan 1 y el mismo texto da el mismo vector
      con y sin relleno. Funciona con el SDK de Python y con el de Node, que pide
      base64 por defecto
- [x] `requirements.txt` en `scripts/embeddings/` y `scripts/seed/`

### Pipeline

Cuatro pasos. Cada uno cachea en `scripts/seed/data/`, se reanuda tras un corte y,
al reejecutarlo, no repite llamadas.

- [x] `fetch-tmdb.py`: descubre por años los títulos con más votos (`/discover`
      no pasa de 500 páginas) y trae el detalle de cada uno en **una** llamada con
      `keywords`, `credits` y `translations`. Guarda el detalle recortado: los
      créditos completos pesan ~75 KB por película
- [x] `score.py`: deepseek-flash por lotes de 25, en 3 pasadas sobre todo el
      universo, y media. Hasta el 2026-09-30, una heurística de prefiltro decidía
      qué títulos llegaban al modelo (ver «Repuntuación»)
- [x] `embed.py`: vectoriza sin instrucción, comprueba 1024 dimensiones y valores
      finitos, y guarda cada vector con el hash del texto del que sale
- [x] `load-db.py`: upsert por `(tmdb_id, type)` en lotes de 100 con la secret
      key. `--prune` borra lo que ya no está en el corpus
- [x] `search.py`: búsquedas de control con la publishable key, igual que un
      cliente anónimo

### Números de la carga

| Paso | Resultado |
|---|---|
| Descubrimiento | 22.886 películas con ≥100 votos y 6.472 series con ≥50. Universo: las 15.000 y las 2.000 más votadas |
| Detalle | 17.000 llamadas. Recomendables: 16.996; quedan fuera 4 películas (sin sinopsis, sin estrenar o borradas de TMDB) |
| Prefiltro | Pasan 9.000 películas y 1.000 series (el doble del objetivo) |
| Puntuación | 400 lotes, ninguno fallido, unos 2 minutos con 8 hilos |
| Selección | 4.500 películas y 500 series. Corte en 48/100 en los dos tipos |
| Vectorización | 5.000 vectores en 5 minutos: reindexar es barato |
| Carga | 5.000 filas. 0 sin `embedding`, 0 sin `synopsis_en`, 27 sin `synopsis`, 66 sin `director` (casi todo series sin `created_by`), 0 sin póster |

Reparto de `autumn_score` en películas: 45 en 90–99, 258 en 80–89, 742 en 70–79,
1.283 en 60–69, 1.949 en 50–59 y 223 en 48–49. Casi la mitad del corpus es
«encaja razonablemente con el otoño», que es lo que da de sí pedir 4.500
películas.

### Repuntuación (2026-09-30)

El corpus se inclinaba hacia Halloween y el terror: **el 30 % era terror**
(1.523 de 5.000), y el 25 %, terror sin Halloween ni otoño (*La mujer de negro*,
*Nosferatu*, *Vampyr* en 85–88). Criterio de producto: centrarse en lo que es
**sí o sí de ver en otoño** (*El club de los poetas muertos*, *Las chicas
Gilmore*, *Harry Potter*). El terror vale cuando la propia película va de
Halloween, y el que solo tiene ambiente oscuro puede entrar, pero abajo.

- [x] Prompt nuevo en `score.py`: la temporada por encima del género. Halloween
      y el Día de Muertos cuentan solo si la historia va de ellos o pasa en ellos
      (85–100). El terror con ambiente otoñal puntúa por ese ambiente, y el que no
      tiene ni Halloween ni otoño, 40 como mucho
- [x] **Sin prefiltro heurístico**: se puntúa el universo entero (16.996)
- [x] **3 pasadas** con lotes barajados con otra semilla en cada una, y media.
      Resuelve la pregunta 1
- [x] Calibrado antes con 81 títulos de referencia en una pasada, sin tocar la
      caché
- [x] Vectorizados los 1.613 títulos nuevos y cargado con `--prune`. No había
      favoritos que perder: la base no tenía usuarios

| Paso | Resultado |
|---|---|
| Puntuación | 3 × 680 lotes, ninguno fallido, unos 10 minutos. 1,29 USD en total, contando la calibración y unas 20 llamadas de chat de prueba |
| Selección | 4.500 películas (corte en 38,3) y 500 series (corte en 45) |
| Cambios | Entran 1.613 y salen 1.613. Salen *El resplandor*, *Oppenheimer*, *1917*, *Juego macabro*, *Breaking Bad*; entran *Tienes un e-mail* (90,7), *Almas en pena de Inisherin*, *Community*, *El internado* |
| Terror | Del 30 % al 14 % del corpus; sin Halloween ni otoño, del 25 % al 9 % |
| Pasadas que difieren en 20 o más | 183 películas y 21 series del corpus. Las que más: *Scooby-Doo! Miedo en el campamento* [85, 30, 55] |

Reparto en películas: 91 en 90–99, 189 en 80–89, 116 en 70–79, 264 en 60–69,
1.037 en 50–59, 2.677 en 40–49 y 126 en 30–39. El criterio nuevo es más
estricto, y el universo no tiene 4.500 películas claramente otoñales: 1.697
tienen 50 o más y 4.374, 40 o más. Se mantuvo el tamaño (decisión de producto,
ver Decisiones).

Cómo queda el terror, en la media de las tres pasadas: *La noche de Halloween* y
*Trick 'r Treat* 95, *El proyecto de la bruja de Blair* 88 (un bosque en
octubre), *La bruja* 55, *Hereditary*, *Expediente Warren* y *Babadook* 40
(dentro, abajo), *Midsommar* 16,7, *Viernes 13* 23,3 y *Tiburón* 10 (fuera).
Quedan fallos sueltos que la media no corrige del todo: *It* (2017), que
transcurre en verano, se queda en 66,7 [55, 60, 85]; *E.T.* baja a 45 aunque su
Halloween es central.

Búsquedas de control tras la carga: *brujas o fantasmas* → *El gabinete de
curiosidades de Guillermo del Toro*, *Penny Dreadful*; *nostalgia universitaria*
→ *Amor y letras*, *Diez años después*; *algo acogedor, con mantita y té* →
*Como agua para chocolate*, *Ratatouille*, *Ted Lasso*.

### Cierre

- [x] Búsquedas de control con tres estados de ánimo, sin filtro de tipo:
      - *Lluvia y melancolía* → Cuando cae el otoño, El jardín de las palabras,
        Sonata de otoño, Las hojas muertas, Aftersun
      - *Brujas o fantasmas* → Penny Dreadful, El club de medianoche, Al morir la
        noche, El gabinete de curiosidades de Guillermo del Toro
      - *Nostalgia universitaria* → Reencuentro, Diez años después, Amor y
        letras, Los que se quedan

      La búsqueda cruzada funciona: consultas en español recuperan documentos
      vectorizados en inglés
- [x] Medido el filtro por tipo que la Fase 2 dejó abierto, y corregido con una
      migración (ver Decisiones)
- [x] `npm run db:verify` 18/18 y `npm run db:verify-rls` 21/21 con el corpus
      cargado

## Decisiones tomadas

| Decisión | Motivo |
|---|---|
| El texto canónico que se vectoriza se construye en Python, no en TypeScript | Evita tener la misma lógica en dos lenguajes. El lado TypeScript solo vectoriza consultas, nunca documentos |
| ~~**`autumn_score` mixto**: heurística para descartar y deepseek-flash (0–100, temperatura 0.1) para puntuar~~ Sustituida el 2026-09-30: ver las tres filas siguientes | La heurística sola no distingue una comedia de pueblo en octubre de una de verano; el LLM solo, sobre 17.000 títulos, gasta llamadas en blockbusters obvios. La heurística se comprobó: de todo lo que descartó, solo 3 títulos tenían keywords estacionales (The Dark Knight, 9, Swamp Thing) |
| **Sin prefiltro: deepseek-flash puntúa todo el universo** | La heurística daba +2 al terror y al misterio y 0 a la comedia: descartaba justo lo que el criterio nuevo quiere. *Tienes un e-mail* quedaba en el puesto 10.136 de 14.996 y no llegaba al modelo; *Cuando Harry encontró a Sally* (6.011) y *El indomable Will Hunting* (7.111) pasaban por poco. Puntuarlo todo cuesta unos 0,40 USD por pasada |
| **Otoño antes que Halloween**: el prompt puntúa la temporada, no el género | Decisión de producto. Halloween y el Día de Muertos cuentan solo si la historia va de ellos; el terror con ambiente otoñal, por ese ambiente; el resto del terror, 40 como mucho. Calibrado con 81 títulos: *Cuando Harry encontró a Sally* 48 → 90, *Nosferatu* 88 → 35, *La noche de Halloween* se queda en 95 |
| **Tres pasadas y media**, con lotes de composición distinta. Resuelve la pregunta 1 | La misma película cambiaba hasta 40 puntos según el lote en que caía, justo en la franja del corte. Cada pasada baraja con otra semilla, así que reejecutar sigue dando el mismo corpus. En 183 películas del corpus las pasadas difieren en 20 o más: la media es la que decide |
| **Se mantienen 4.500 películas y 500 series** con el criterio nuevo, aunque el corte baje a 38,3 | Decisión de producto: con corte en 45 quedarían unas 2.700 y con 50, unas 1.700. El terror sin Halloween entra, pero abajo (*Hereditary* 40), y el de verano se queda fuera (*Midsommar* 16,7). Lo otoñal se prioriza al reordenar en el chat, con peso 0,2 (Fase 4) |
| **`autumn_score` filtra y ordena** | Entran al corpus los 5.000 mejor puntuados, así que Umber solo conoce títulos otoñales. En la Fase 4 se combina con la similitud para reordenar |
| **Reparto 90/10**: 4.500 películas y 500 series | Decisión de producto. TMDB tiene muchas menos series con votos suficientes |
| **Vectorizar en inglés**, con la sinopsis española solo si falta la inglesa | TMDB solo tiene keywords en inglés, sus sinopsis inglesas son más completas (faltan 2 en inglés frente a 369 en español) y es donde mejor rinde el modelo. Las búsquedas de control confirman que la recuperación cruzada funciona |
| Texto del documento: título, año, sinopsis, géneros y hasta 20 keywords | Las keywords llevan la mayor parte de la señal otoñal («small town», «halloween», «boarding school») y no están en la sinopsis |
| Las puntuaciones del LLM se cachean con un hash del prompt | Resuelve la objeción de que el LLM «no es reproducible»: se calcula una vez y reejecutar da el mismo corpus. Cambiar el prompt invalida la caché sola |
| Puntuar **sin razonamiento** (`thinking: disabled`) y sin streaming | deepseek-flash razona por defecto: 463 tokens para puntuar un solo título, y con 25 la respuesta no cabía en `max_tokens`. Sin razonamiento, un lote de 25 tarda 1,6 s. Es un proceso por lotes: el streaming no aporta nada |
| Una sola llamada de detalle por título con `translations`, en vez de una por idioma | La mitad de llamadas. `translations` trae título y sinopsis de todas las variantes de español e inglés |
| Detalle pedido en `es-ES` | Para que `poster_path` sea el cartel español cuando exista |
| En la traducción del idioma original, el título sale de `original_title` | TMDB la deja con el título vacío: sin esto, *Fight Club* se quedaba sin `title_en` |
| Traducción propia de cuatro géneros de series | TMDB deja en inglés, en su lista es-ES, «Action & Adventure», «Kids», «Sci-Fi & Fantasy» y «War & Politics» |
| `director` de una serie = sus creadores | En TMDB las series no tienen director; `created_by` es el equivalente |
| Fuera del universo: noticias, reality, telenovela, talk shows y películas de 40 minutos o menos | No son lo que se recomienda para una tarde. 40 minutos es la definición de largometraje de la Academia |
| Fuera también los títulos sin estrenar o sin ninguna sinopsis | Sin sinopsis no hay nada que vectorizar ni que contar al usuario |
| Servidor de embeddings propio en Python, en lugar del contenedor de TEI | No hay Docker en la máquina, y en una empresa grande Docker Desktop exige licencia de pago. El contrato es el mismo, así que el código TypeScript no cambia |
| Modelo cargado en **float32** | transformers 5 carga por defecto el bfloat16 del checkpoint. Con él, las normas salían en 1,0012 y el mismo texto daba vectores distintos según el lote (similitud 0,9996 consigo mismo). En float32 coincide exactamente con la ficha |
| Se mantiene el índice HNSW durante la carga | El pendiente pedía crearlo después, pero ya existe desde la Fase 2 y, con 5.000 filas, mantenerlo durante el upsert cuesta segundos. Quitarlo y recrearlo exigiría una migración para nada. **Matiz (2026-10-03)**: cada carga reescribe todas las filas, y tras varias el grafo se degrada (70 MB, el 92,5 % de los 10 mejores frente a la búsqueda exacta). Tras una carga grande, `reindex`: ver `CLAUDE.md` y la Fase 6 |
| **Título español en el texto vectorizado** (2026-10-03) | Sin él, «Cadena perpetua» no encontraba *The Shawshank Redemption*. Medidas en la [Fase 6](fase-6-pulido-despliegue.md) |
| **Un segundo vector, de lo que cuenta cada título sin su nombre** (`plot_text`, 2026-10-03), solo para «Más como esta» | Con el vector de búsqueda, que lleva el título, los parecidos salían por el nombre: *El club de los poetas muertos* junto a *El baile de los muertos* y *El club de los canallas*; *Cuando Harry encontró a Sally* junto a *Harry, un amigo que os quiere*. Con el nuevo: *The History Boys*, *Los chicos del coro*, *Rebelión en las aulas*; *Mejor... imposible*, *Chicos y chicas*. Comparados 8 títulos a mano. Cuesta otra pasada de Cloudflare (5.000 textos, gratis) |
| **Los parecidos se calculan en el seed y se guardan** (`content_similar`, 12 por título), sin guardar el segundo vector | Otra columna de 1024 dimensiones con su índice HNSW serían unos 60 MB de los 500 del plan gratuito (la base ocupa 116). La tabla son 60.000 filas pequeñas, la ficha la lee sin búsqueda vectorial, y por fuerza bruta en numpy el resultado es exacto. `load-db.py --similar-only` los recalcula sin reescribir `content` |
| **`hnsw.iterative_scan = strict_order` en `search_content`** (migración `20260929235200`) | Resuelve la pregunta 1 de la Fase 2. Un recorrido HNSW devuelve como mucho `ef_search` filas (40), y el filtro se aplica después. Con el plan genérico que PL/pgSQL acaba usando en las conexiones de PostgREST, **295 de 300 búsquedas de series se quedaban cortas: 2,67 filas de media, alguna con 0**. Sin filtro, pedir 50 devolvía 40. Con la búsqueda iterativa de pgvector 0.8.2: 10 de 10 y 50 de 50. `strict_order` mantiene el orden exacto por distancia |

## Preguntas abiertas

**1. ~~La puntuación del LLM varía según el lote.~~**
Resuelta el 2026-09-30: tres pasadas con lotes distintos y media (ver
Decisiones). Lo que la motivó, el mismo título puntuado en dos lotes distintos:

| Título | Prueba | Pasada completa |
|---|---|---|
| Hocus Pocus | 98 | 98 |
| Mamma Mia! | 5 | 5 |
| Fantastic Mr. Fox | 78 | 72 |
| Good Will Hunting | 55 | 68 |
| Cuando Harry encontró a Sally | 60 | 48 |
| El resplandor | 30 | 68 |

En los extremos es estable; en la franja media hay ruido de ±10 a ±40, justo
donde está el corte (48). La caché hace el resultado reproducible, pero no más
preciso. La salida natural es puntuar cada título dos o tres veces en lotes de
composición distinta y promediar: céntimos y unos 2 minutos por pasada. Merece
la pena antes de que el reordenado de la Fase 4 dependa de este número. (Al
final, sobre todo el universo: unos 0,40 USD y 3 minutos por pasada.)

**2. ~~La instrucción de la consulta arrastra hacia títulos con «otoño».~~**
Resuelta en la Fase 4: la instrucción ya no dice «autumnal». De 14 títulos
estacionales en 120 resultados se pasa a 0. Medidas y motivo en las
[decisiones de la Fase 4](fase-4-api-chat.md#decisiones-tomadas).

**3. `runtime` de las series es poco fiable.**
TMDB ha dejado de rellenar `episode_run_time` en muchas series, y entonces se
usa la duración del último episodio emitido: *Stranger Things* sale con 129
minutos, que es lo que dura su final. No afecta al MVP. Importará en los modos
`weekend` y `month`, que planifican por tiempo.

## Verificación

- [x] `count(*)` de `content` = 5.000: 4.500 `movie` y 500 `tv`
- [x] Ninguna fila con `embedding IS NULL`
- [x] `search_content` con consultas reales devuelve títulos coherentes, y
      devuelve las filas pedidas también al filtrar por tipo
- [x] Reejecutar el pipeline no duplica filas: `fetch-tmdb.py` y `embed.py` no
      descargan ni vectorizan nada, `score.py` no hace llamadas y produce un
      `corpus.jsonl` idéntico byte a byte, y `load-db.py` deja las mismas 5.000

```bash
python scripts/seed/search.py --type tv "misterio en un pueblo pequeño"
```
