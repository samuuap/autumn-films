/**
 * Verifica el aislamiento de RLS entre dos usuarios distintos.
 *
 *   node scripts/verify-rls.mjs
 *
 * `verify-schema.mjs` comprueba que `anon` no ve nada, lo que demuestra que RLS
 * está activo. Esto comprueba lo otro: que un usuario autenticado no alcanza las
 * filas de otro. Una política mal escrita no da error, da datos de más.
 *
 * Crea dos usuarios de prueba con la Admin API y los borra al terminar. El
 * borrado cae en cascada sobre sus conversaciones y favoritos.
 */
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.includes('=') && !line.trimStart().startsWith('#'))
    .map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
);

const { SUPABASE_URL: BASE, SUPABASE_PUBLISHABLE_KEY: ANON, SUPABASE_SECRET_KEY: SECRET } = env;

const results = [];
const record = (ok, label, detail = '') => {
  results.push({ ok, label, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
};

async function req(url, { key = ANON, token, method = 'GET', body, prefer } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token ?? key}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed };
}

const rest = (path, options) => req(`${BASE}/rest/v1${path}`, options);

const stamp = Date.now();
const users = {
  a: { email: `umber-rls-a-${stamp}@example.com`, password: `Aa${stamp}!xY`, username: `rls_a_${stamp}` },
  b: { email: `umber-rls-b-${stamp}@example.com`, password: `Bb${stamp}!xY`, username: `rls_b_${stamp}` },
};

console.log(`\nProyecto: ${BASE}\n`);
const cleanup = { userIds: [], contentId: null };

try {
  console.log('Preparación');
  for (const [name, user] of Object.entries(users)) {
    const created = await req(`${BASE}/auth/v1/admin/users`, {
      key: SECRET, method: 'POST',
      body: {
        email: user.email, password: user.password, email_confirm: true,
        user_metadata: { username: user.username },
      },
    });
    user.id = created.body?.id;
    if (user.id) cleanup.userIds.push(user.id);
    record(created.status === 200 && Boolean(user.id),
      `usuario ${name.toUpperCase()} creado`, user.id ?? JSON.stringify(created.body));

    const session = await req(`${BASE}/auth/v1/token?grant_type=password`, {
      method: 'POST', body: { email: user.email, password: user.password },
    });
    user.token = session.body?.access_token;
    record(Boolean(user.token), `usuario ${name.toUpperCase()} inicia sesión`,
      user.token ? 'token obtenido' : JSON.stringify(session.body));
  }

  const content = await rest('/content', {
    key: SECRET, method: 'POST', prefer: 'return=representation',
    body: { tmdb_id: -998001, type: 'movie', title: '__rls__ título de prueba' },
  });
  cleanup.contentId = Array.isArray(content.body) ? content.body[0]?.id : null;
  record(Boolean(cleanup.contentId), 'título de prueba en el corpus', `HTTP ${content.status}`);

  const { a, b } = users;
  if (!a.token || !b.token) throw new Error('sin sesiones no se puede seguir');

  // ─── Conversaciones ────────────────────────────────────────────────────────
  console.log('\nConversaciones');
  const conv = await rest('/conversations', {
    token: a.token, method: 'POST', prefer: 'return=representation',
    body: { user_id: a.id, mode: 'movie', messages: [{ role: 'user', content: 'hola' }] },
  });
  const convId = Array.isArray(conv.body) ? conv.body[0]?.id : null;
  record(conv.status === 201 && Boolean(convId), 'A crea su conversación', `HTTP ${conv.status}`);

  {
    const own = await rest('/conversations?select=id', { token: a.token });
    record(Array.isArray(own.body) && own.body.length === 1, 'A ve su conversación',
      `${own.body?.length ?? '?'} fila(s)`);
  }
  {
    const other = await rest(`/conversations?select=id&id=eq.${convId}`, { token: b.token });
    record(Array.isArray(other.body) && other.body.length === 0,
      'B NO ve la conversación de A', `${other.body?.length ?? '?'} fila(s)`);
  }
  {
    const patched = await rest(`/conversations?id=eq.${convId}`, {
      token: b.token, method: 'PATCH', prefer: 'return=representation',
      body: { messages: [{ role: 'user', content: 'secuestrada' }] },
    });
    record(Array.isArray(patched.body) && patched.body.length === 0,
      'B NO puede modificar la conversación de A', `${patched.body?.length ?? '?'} fila(s) afectadas`);
  }
  {
    const deleted = await rest(`/conversations?id=eq.${convId}`, {
      token: b.token, method: 'DELETE', prefer: 'return=representation',
    });
    record(Array.isArray(deleted.body) && deleted.body.length === 0,
      'B NO puede borrar la conversación de A', `${deleted.body?.length ?? '?'} fila(s) afectadas`);
  }
  {
    const impostor = await rest('/conversations', {
      token: b.token, method: 'POST', body: { user_id: a.id, mode: 'tv', messages: [] },
    });
    record(impostor.status === 401 || impostor.status === 403,
      'B NO puede crear una conversación a nombre de A', `HTTP ${impostor.status}`);
  }
  {
    const append = (token, content) => rest('/rpc/append_conversation_messages', {
      token, method: 'POST', body: { p_id: convId, p_messages: [{ role: 'user', content }] },
    });
    const own = await append(a.token, 'sigo');
    const other = await append(b.token, 'intruso');
    const read = await rest(`/conversations?select=messages&id=eq.${convId}`, { token: a.token });
    const messages = Array.isArray(read.body) ? read.body[0]?.messages ?? [] : [];
    record(own.body === true && messages.at(-1)?.content === 'sigo',
      'A añade mensajes a su conversación con append_conversation_messages', JSON.stringify(own.body));
    record(other.body === false && !messages.some((m) => m.content === 'intruso'),
      'B NO puede añadir mensajes a la conversación de A', JSON.stringify(other.body));
  }

  // ─── Perfiles ──────────────────────────────────────────────────────────────
  console.log('\nPerfiles');
  {
    const own = await rest('/profiles?select=id,username', { token: a.token });
    record(Array.isArray(own.body) && own.body.length === 1 && own.body[0]?.username === a.username,
      'el alta crea el perfil de A con su nombre de usuario, y A solo ve el suyo', JSON.stringify(own.body));
  }
  {
    const other = await rest(`/profiles?select=id&id=eq.${a.id}`, { token: b.token });
    record(Array.isArray(other.body) && other.body.length === 0, 'B NO ve el perfil de A',
      `${other.body?.length ?? '?'} fila(s)`);
  }
  {
    const patched = await rest(`/profiles?id=eq.${a.id}`, {
      token: a.token, method: 'PATCH', prefer: 'return=representation', body: { username: 'a_mano' },
    });
    record(Array.isArray(patched.body) && patched.body.length === 0,
      'A NO puede editar su perfil a mano (solo vía Auth)', `${patched.body?.length ?? '?'} fila(s) afectadas`);
  }
  {
    const taken = await req(`${BASE}/auth/v1/admin/users`, {
      key: SECRET, method: 'POST',
      body: {
        email: `umber-rls-c-${stamp}@example.com`, password: `Cc${stamp}!xY`, email_confirm: true,
        user_metadata: { username: a.username },
      },
    });
    if (taken.body?.id) cleanup.userIds.push(taken.body.id);
    record(taken.status >= 400, 'una cuenta nueva NO puede quedarse el nombre de A', `HTTP ${taken.status}`);
  }
  {
    const steal = await req(`${BASE}/auth/v1/user`, {
      token: b.token, method: 'PUT', body: { data: { username: a.username } },
    });
    record(steal.status >= 400, 'B NO puede cambiarse al nombre de A', `HTTP ${steal.status}`);
  }
  {
    const renamed = `rls_r_${stamp}`; // 20 caracteres como mucho
    const change = await req(`${BASE}/auth/v1/user`, {
      token: b.token, method: 'PUT', body: { data: { username: renamed } },
    });
    const read = await rest('/profiles?select=username', { token: b.token });
    record(change.status === 200 && read.body?.[0]?.username === renamed,
      'cambiar el nombre en Auth lo cambia en el perfil', `HTTP ${change.status} → ${JSON.stringify(read.body)}`);
  }

  // ─── Favoritos ─────────────────────────────────────────────────────────────
  console.log('\nFavoritos');
  if (cleanup.contentId) {
    const fav = await rest('/users_favorites', {
      token: a.token, method: 'POST', prefer: 'return=representation',
      body: { user_id: a.id, content_id: cleanup.contentId },
    });
    record(fav.status === 201, 'A guarda un favorito', `HTTP ${fav.status}`);

    const mine = await rest('/users_favorites?select=id', { token: a.token });
    record(Array.isArray(mine.body) && mine.body.length === 1, 'A ve su favorito',
      `${mine.body?.length ?? '?'} fila(s)`);

    const theirs = await rest('/users_favorites?select=id', { token: b.token });
    record(Array.isArray(theirs.body) && theirs.body.length === 0, 'B NO ve el favorito de A',
      `${theirs.body?.length ?? '?'} fila(s)`);

    const dup = await rest('/users_favorites', {
      token: a.token, method: 'POST',
      body: { user_id: a.id, content_id: cleanup.contentId },
    });
    record(dup.status === 409, 'unique(user_id, content_id) impide duplicar el favorito',
      `HTTP ${dup.status}`);

    const removed = await rest(`/users_favorites?content_id=eq.${cleanup.contentId}`, {
      token: a.token, method: 'DELETE', prefer: 'return=representation',
    });
    record(Array.isArray(removed.body) && removed.body.length === 1, 'A quita su favorito',
      `${removed.body?.length ?? '?'} fila(s)`);
  }

  // ─── Corpus ────────────────────────────────────────────────────────────────
  console.log('\nCorpus');
  {
    const read = await rest('/content?select=id&limit=1', { token: a.token });
    record(read.status === 200, 'un usuario autenticado puede leer el corpus', `HTTP ${read.status}`);

    const write = await rest('/content', {
      token: a.token, method: 'POST',
      body: { tmdb_id: -998002, type: 'movie', title: '__rls__ no debería entrar' },
    });
    record(write.status === 401 || write.status === 403,
      'un usuario autenticado NO puede escribir en el corpus', `HTTP ${write.status}`);
  }
} catch (error) {
  record(false, 'ejecución interrumpida', error instanceof Error ? error.message : String(error));
} finally {
  console.log('\nLimpieza');
  for (const id of cleanup.userIds) {
    const { status } = await req(`${BASE}/auth/v1/admin/users/${id}`, { key: SECRET, method: 'DELETE' });
    record(status === 200, `usuario ${id.slice(0, 8)}… borrado`, `HTTP ${status}`);
  }
  const { status } = await rest('/content?title=like.__rls__*', { key: SECRET, method: 'DELETE' });
  record(status < 300, 'títulos de prueba borrados', `HTTP ${status}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} comprobaciones correctas`);
if (failed.length > 0) {
  console.log('\nFallos:');
  for (const f of failed) console.log(`  ✗ ${f.label} — ${f.detail}`);
  process.exit(1);
}
console.log('Aislamiento de RLS verificado.\n');
