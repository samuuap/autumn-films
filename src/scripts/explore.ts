/**
 * En `/explorar`, cambiar el género o el orden aplica el filtro sin pulsar
 * «Buscar». Sin JavaScript, el botón hace lo mismo.
 */
document.querySelectorAll<HTMLSelectElement>('form[data-explore-filters] select').forEach((select) => {
  select.addEventListener('change', () => {
    select.form?.requestSubmit();
  });
});
