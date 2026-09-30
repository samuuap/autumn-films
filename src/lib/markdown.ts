/**
 * Convierte el texto de Umber en HTML. Se usa en el servidor (conversaciones
 * guardadas) y en el navegador (el stream), así que no importa nada de servidor.
 *
 * El texto viene de un LLM: se escapa todo antes de dar formato. `system.md` solo
 * le permite texto corrido y títulos en **negrita**, así que no hace falta más.
 */

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (char) => HTML_ESCAPES[char] ?? char);
}

/** Párrafos por línea en blanco, `**negrita**` y saltos de línea sueltos. */
export function renderReply(text: string): string {
  return text
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map(
      (paragraph) =>
        `<p>${escapeHtml(paragraph)
          .replace(/\*\*([^*\n]+?)\*\*/gu, '<strong>$1</strong>')
          .replace(/\n/gu, '<br>')}</p>`,
    )
    .join('');
}
