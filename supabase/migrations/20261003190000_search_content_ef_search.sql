-- `search_content` explora más candidatos del índice HNSW: `ef_search` 100 en
-- vez de 40, el valor por defecto.
--
-- Medido el 2026-10-03 contra la búsqueda exacta, en 20 consultas: con 40, el
-- índice devolvía de media el 94 % de los 10 mejores, y en las búsquedas por
-- título se quedaba en el 70 % (en ellas muchos títulos tienen casi la misma
-- similitud). «Cadena perpetua» llegó a dejarse fuera *Cadena perpetua*. Las de
-- ánimo ya daban el 100 %. Con 5.000 filas, el coste son milisegundos.
--
-- `alter function ... set` conserva el resto de la configuración de la función
-- (`search_path`, `hnsw.iterative_scan`).

-- Carga pgvector en la sesión para que `hnsw.ef_search` se valide contra su
-- definición real (ver 20260929235200).
select extensions.vector_dims('[1]'::extensions.vector);

alter function public.search_content(extensions.vector, text, integer, double precision)
  set hnsw.ef_search = 100;
