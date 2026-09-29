-- Búsqueda iterativa en el índice HNSW de search_content.
--
-- Un recorrido HNSW devuelve como mucho `hnsw.ef_search` filas (40 por
-- defecto), y los filtros del WHERE se aplican después sobre esas 40. Medido con
-- el corpus de la Fase 3 (4.500 películas y 500 series):
--
--   - Sin filtro o con 'movie', pedir más de 40 devolvía 40 o menos.
--   - Con 'tv', 295 de 300 búsquedas de 10 se quedaban cortas: 2,67 filas de
--     media, y alguna con 0. El chat en modo `tv` se habría quedado sin
--     candidatos y lo habría confundido con «ningún título encaja».
--
-- Con una sesión nueva no se ve: las primeras llamadas usan un plan a medida
-- que conoce `content_type` y hace un recorrido exacto. El fallo aparece cuando
-- PL/pgSQL pasa al plan genérico, que es lo que ocurre en las conexiones que
-- PostgREST reutiliza.
--
-- pgvector 0.8 sigue recorriendo el índice hasta completar el LIMIT.
-- `strict_order` mantiene el orden exacto por distancia; `relaxed_order` obligaría
-- a reordenar fuera. El tope de la búsqueda es `hnsw.max_scan_tuples` (20.000 por
-- defecto), por encima del tamaño del corpus.

-- Carga la biblioteca de pgvector en esta sesión para que el parámetro se valide
-- contra su definición real: si la versión instalada no lo tuviera, la
-- migración falla aquí en vez de dejar la función rota.
select extensions.vector_dims('[1]'::extensions.vector);

alter function public.search_content(extensions.vector, text, integer, double precision)
  set hnsw.iterative_scan = strict_order;

comment on column public.content.autumn_score is
  'Cuán otoñal es el título, de 0 a 1: la puntuación de deepseek-flash / 100 (scripts/seed/score.py).';
