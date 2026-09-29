# Fase 3 — Seed del corpus

**Estado:** ✅ Completada
**Depende de:** [Fase 2](fase-2-base-de-datos.md) ✅
**Actualizado:** 2026-09-29

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
- [x] `score.py`: heurística de prefiltro + deepseek-flash por lotes de 25
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
| **`autumn_score` mixto**: heurística para descartar y deepseek-flash (0–100, temperatura 0.1) para puntuar | La heurística sola no distingue una comedia de pueblo en octubre de una de verano; el LLM solo, sobre 17.000 títulos, gasta llamadas en blockbusters obvios. La heurística se comprobó: de todo lo que descartó, solo 3 títulos tenían keywords estacionales (The Dark Knight, 9, Swamp Thing) |
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
| Se mantiene el índice HNSW durante la carga | El pendiente pedía crearlo después, pero ya existe desde la Fase 2 y, con 5.000 filas, mantenerlo durante el upsert cuesta segundos. Quitarlo y recrearlo exigiría una migración para nada |
| **`hnsw.iterative_scan = strict_order` en `search_content`** (migración `20260929235200`) | Resuelve la pregunta 1 de la Fase 2. Un recorrido HNSW devuelve como mucho `ef_search` filas (40), y el filtro se aplica después. Con el plan genérico que PL/pgSQL acaba usando en las conexiones de PostgREST, **295 de 300 búsquedas de series se quedaban cortas: 2,67 filas de media, alguna con 0**. Sin filtro, pedir 50 devolvía 40. Con la búsqueda iterativa de pgvector 0.8.2: 10 de 10 y 50 de 50. `strict_order` mantiene el orden exacto por distancia |

## Preguntas abiertas

**1. La puntuación del LLM varía según el lote.**
El mismo título puntuado en dos lotes distintos:

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
la pena antes de que el reordenado de la Fase 4 dependa de este número.

**2. La instrucción de la consulta arrastra hacia títulos con «otoño».**
Con *«está lloviendo y estoy melancólico»*, cuatro de los diez primeros llevan
el otoño o las estaciones en el título (*Cuando cae el otoño*, *Sonata de
otoño*…), aunque la consulta no lo menciona. La instrucción de `EMBEDDING_TASK`
dice «retrieve the autumnal film»: como todo el corpus ya es otoñal, esa palabra
no filtra nada y en cambio sesga hacia coincidencias literales. Probar en la
Fase 4 una instrucción centrada en el estado de ánimo. Afecta solo a las
consultas: no obliga a reindexar.

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
