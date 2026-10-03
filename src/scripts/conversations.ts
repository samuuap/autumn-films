/**
 * Borrar una conversación no se puede deshacer: con JavaScript, se pregunta
 * antes. Sin él, el formulario borra al pulsar.
 */
document.querySelectorAll<HTMLFormElement>('form[data-delete-conversation]').forEach((form) => {
  form.addEventListener('submit', (event) => {
    if (!window.confirm('¿Borrar esta conversación? No se puede deshacer.')) event.preventDefault();
  });
});
