/**
 * Lo que añade JavaScript al formulario de entrar y registrarse (`AuthForm.astro`):
 * mostrar la contraseña y avisar al momento si las dos no coinciden. Sin él, el
 * formulario funciona igual y el servidor lo valida todo.
 */
const MISMATCH = 'Las contraseñas no coinciden.';

function initPasswordToggles(form: HTMLFormElement): void {
  const inputs: HTMLInputElement[] = [];
  form.querySelectorAll<HTMLButtonElement>('[data-password-toggle]').forEach((button) => {
    const input = document.getElementById(button.getAttribute('aria-controls') ?? '');
    const label = button.querySelector('[data-label]');
    if (!(input instanceof HTMLInputElement) || label === null) return;
    inputs.push(input);
    button.hidden = false;
    button.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      label.textContent = show ? 'Ocultar' : 'Mostrar';
    });
  });
  // Con el campo en `text`, los gestores de contraseñas no ofrecen guardarla.
  form.addEventListener('submit', () => {
    inputs.forEach((input) => {
      input.type = 'password';
    });
  });
}

function initPasswordMatch(form: HTMLFormElement): void {
  const password = form.querySelector<HTMLInputElement>('input[name="password"]');
  const confirm = form.querySelector<HTMLInputElement>('input[name="password_confirm"]');
  const status = form.querySelector<HTMLElement>('[data-password-match]');
  if (password === null || confirm === null || status === null) return;

  // No se avisa mientras se está escribiendo la segunda por primera vez.
  let touched = false;
  const update = (): void => {
    const mismatch = confirm.value.length > 0 && confirm.value !== password.value;
    confirm.setCustomValidity(mismatch ? MISMATCH : '');
    status.hidden = !touched || confirm.value.length === 0;
    status.dataset.state = mismatch ? 'mismatch' : 'match';
    status.textContent = mismatch ? MISMATCH : 'Las contraseñas coinciden.';
  };

  password.addEventListener('input', update);
  confirm.addEventListener('input', () => {
    if (confirm.value.length >= password.value.length) touched = true;
    update();
  });
  confirm.addEventListener('blur', () => {
    touched = true;
    update();
  });
}

export function initAuthForms(): void {
  document.querySelectorAll<HTMLFormElement>('form[data-auth-form]').forEach((form) => {
    initPasswordToggles(form);
    initPasswordMatch(form);
  });
}
