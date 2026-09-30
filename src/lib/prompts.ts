/**
 * Plantillas de `src/prompts/`, cargadas como texto en build.
 *
 * Solo servidor: el system prompt nunca se expone al cliente.
 */
import systemPromptSource from '@/prompts/system.md?raw';
import userContextSource from '@/prompts/user-context.md?raw';

import { ConfigError } from '@/lib/errors';

/** Los comentarios HTML documentan la plantilla para quien la edita, no para el modelo. */
function stripComments(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->/gu, '').trim();
}

export const SYSTEM_PROMPT = stripComments(systemPromptSource);

const USER_CONTEXT_TEMPLATE = stripComments(userContextSource);

/** Las `{{variables}}` que documenta `user-context.md`. */
export interface UserContextValues {
  readonly mode: string;
  readonly mode_label: string;
  readonly locale: string;
  readonly region: string;
  readonly today: string;
  readonly user_message: string;
  readonly candidates: string;
  readonly already_recommended: string;
}

/**
 * Sustituye cada `{{variable}}` en una sola pasada: el texto sustituido no se
 * vuelve a examinar, así que un mensaje que contenga `{{candidates}}` no inyecta
 * la lista de candidatos donde no toca.
 */
export function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{(\w+)\}\}/gu, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new ConfigError(`La plantilla usa {{${name}}}, que no tiene valor.`);
    }
    return value;
  });
}

export function renderUserContext(values: UserContextValues): string {
  return renderTemplate(USER_CONTEXT_TEMPLATE, { ...values });
}
