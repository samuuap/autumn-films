/**
 * Verifica que el esquema esté aplicado y que RLS se comporte: el de la Fase 2
 * y lo que añadió la 4 (caché de plataformas y rate limiting).
 *
 *   node scripts/verify-schema.mjs
 *
 * Usa el Data API con las claves de `.env.local`, así que no necesita Docker ni
 * acceso directo a Postgres. Los datos de prueba que crea los borra al final.
 */
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.includes('=') && !line.trimStart().startsWith('#'))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }),
);

const URL_BASE = `${env.SUPABASE_URL}/rest/v1`;
const ANON = env.SUPABASE_PUBLISHABLE_KEY;
const SECRET = env.SUPABASE_SECRET_KEY;

const results = [];
const record = (ok, label, detail = '') => {
  results.push({ ok, label, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  — ${detail}` : ''}`);
};

async function call(path, { key = ANON, method = 'GET', body, prefer } = {}) {
  const response = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

console.log(`\nProyecto: ${env.SUPABASE_URL}\n`);

// ─── Estructura ──────────────────────────────────────────────────────────────
console.log('Estructura');
for (const table of ['content', 'users_favorites', 'conversations', 'platforms_cache', 'rate_limits']) {
  const { status, body } = await call(`/${table}?select=*&limit=0`, { key: SECRET });
  record(status === 200, `tabla ${table} existe`, status === 200 ? '' : JSON.stringify(body));
}

{
  const vector = JSON.stringify(Array.from({ length: 1024 }, () => Math.random() - 0.5));
  const { status, body } = await call('/rpc/search_content', {
    method: 'POST',
    body: { query_embedding: vector, content_type: 'movie', match_count: 5, min_score: 0.0 },
  });
  record(status === 200, 'search_content responde a un vector de 1024 dim',
    status === 200 ? `${Array.isArray(body) ? body.length : '?'} filas` : JSON.stringify(body));
}

{
  const vector = JSON.stringify(Array.from({ length: 512 }, () => 0.1));
  const { status } = await call('/rpc/search_content', {
    method: 'POST', body: { query_embedding: vector },
  });
  record(status >= 400 && status !== 404,
    'search_content rechaza una dimensión incorrecta',
    status === 404 ? 'la función no existe: no prueba nada' : `HTTP ${status}`);
}

// ─── RLS ─────────────────────────────────────────────────────────────────────
console.log('\nRow Level Security');
{
  const { status } = await call('/content?select=id&limit=1');
  record(status === 200, 'anon puede LEER el corpus', `HTTP ${status}`);
}
{
  const { status } = await call('/content', {
    method: 'POST', body: { tmdb_id: -1, type: 'movie', title: 'no debería entrar' },
  });
  record(status === 401 || status === 403, 'anon NO puede escribir en el corpus', `HTTP ${status}`);
}
for (const table of ['conversations', 'users_favorites']) {
  const { status, body } = await call(`/${table}?select=id&limit=1`);
  const blocked = status === 200 && Array.isArray(body) && body.length === 0;
  record(blocked || status === 401 || status === 403,
    `anon NO ve ${table}`, status === 200 ? 'conjunto vacío por RLS' : `HTTP ${status}`);
}
// Estas dos no tienen políticas y además se les retiran los permisos: ni vacío, error.
for (const table of ['platforms_cache', 'rate_limits']) {
  const { status } = await call(`/${table}?select=*&limit=1`);
  record(status === 401 || status === 403, `anon NO puede leer ${table}`, `HTTP ${status}`);
}
{
  const { status } = await call('/rpc/hit_rate_limit', {
    method: 'POST', body: { p_key: '__verify__ anon', p_window_seconds: [60], p_limits: [1] },
  });
  // 404 si no existe: lo descarta la comprobación de la secret key, más abajo.
  record(status === 401 || status === 403 || status === 404,
    'anon NO puede llamar a hit_rate_limit (gastaría el cupo de otra IP)', `HTTP ${status}`);
}

// ─── Restricciones ───────────────────────────────────────────────────────────
console.log('\nRestricciones');
const MARKER = -999000;
const seed = (tmdb_id, type) => ({ tmdb_id, type, title: `__verify__ ${type}` });

{
  const a = await call('/content', { method: 'POST', key: SECRET, body: seed(MARKER, 'movie') });
  record(a.status === 201, 'insert de prueba en content', `HTTP ${a.status}`);

  const dup = await call('/content', { method: 'POST', key: SECRET, body: seed(MARKER, 'movie') });
  record(dup.status === 409, 'unique(tmdb_id, type) rechaza el duplicado exacto', `HTTP ${dup.status}`);

  const other = await call('/content', { method: 'POST', key: SECRET, body: seed(MARKER, 'tv') });
  record(other.status === 201,
    'mismo tmdb_id con type distinto SÍ entra (espacios de id separados en TMDB)',
    `HTTP ${other.status}`);

  const bad = await call('/content', {
    method: 'POST', key: SECRET,
    body: { tmdb_id: MARKER - 1, type: 'documental', title: '__verify__ tipo inválido' },
  });
  record(bad.status >= 400 && bad.status !== 404,
    'check de type rechaza un valor fuera de (movie, tv)',
    bad.status === 404 ? 'la tabla no existe: no prueba nada' : `HTTP ${bad.status}`);
}

{
  const created = await call('/conversations', {
    method: 'POST', key: SECRET, prefer: 'return=representation',
    body: { mode: 'movie', messages: [] },
  });
  const row = Array.isArray(created.body) ? created.body[0] : null;
  record(created.status === 201 && row !== null, 'insert de prueba en conversations', `HTTP ${created.status}`);

  if (row) {
    const updated = await call(`/conversations?id=eq.${row.id}`, {
      method: 'PATCH', key: SECRET, prefer: 'return=representation',
      body: { messages: [{ role: 'user', content: 'hola' }] },
    });
    const after = Array.isArray(updated.body) ? updated.body[0] : null;
    record(after !== null && after.updated_at !== row.updated_at,
      'el trigger actualiza updated_at al modificar',
      after ? `${row.updated_at} → ${after.updated_at}` : 'sin respuesta');

    const badMode = await call('/conversations', {
      method: 'POST', key: SECRET, body: { mode: 'serie', messages: [] },
    });
    record(badMode.status >= 400, 'check de mode rechaza un modo inexistente', `HTTP ${badMode.status}`);

    const modes = await Promise.all(
      ['weekend', 'month'].map((mode) =>
        call('/conversations', { method: 'POST', key: SECRET, body: { mode, messages: [] } })),
    );
    record(modes.every((m) => m.status === 201),
      'los modos weekend y month de la v2 son válidos en el esquema');
  }
}

// ─── Caché de plataformas y rate limiting (Fase 4) ───────────────────────────
console.log('\nCaché de plataformas y rate limiting');
{
  const created = await call('/content', {
    method: 'POST', key: SECRET, prefer: 'return=representation', body: seed(MARKER - 2, 'movie'),
  });
  const row = Array.isArray(created.body) ? created.body[0] : null;
  if (row) {
    const ok = await call('/platforms_cache', {
      method: 'POST', key: SECRET, body: { content_id: row.id, by_region: { ES: ['Filmin'] } },
    });
    record(ok.status === 201, 'platforms_cache guarda un objeto región → plataformas', `HTTP ${ok.status}`);

    const bad = await call('/platforms_cache?on_conflict=content_id', {
      method: 'POST', key: SECRET, prefer: 'resolution=merge-duplicates',
      body: { content_id: row.id, by_region: ['Filmin'] },
    });
    record(bad.status >= 400, 'platforms_cache rechaza un by_region que no es objeto', `HTTP ${bad.status}`);
  } else {
    record(false, 'insert de prueba en content para la caché', `HTTP ${created.status}`);
  }
}
{
  // Clave única por ejecución: una ventana de 60 s de una ejecución anterior no molesta.
  const key = `__verify__ ${Date.now()}`;
  const hit = () => call('/rpc/hit_rate_limit', {
    method: 'POST', key: SECRET, body: { p_key: key, p_window_seconds: [60, 86400], p_limits: [2, 100] },
  });
  const first = await hit();
  const second = await hit();
  const third = await hit();
  record(first.body === 0 && second.body === 0,
    'hit_rate_limit deja pasar hasta el límite', `${JSON.stringify(first.body)}, ${JSON.stringify(second.body)}`);
  record(typeof third.body === 'number' && third.body > 0 && third.body <= 60,
    'hit_rate_limit rechaza la siguiente y dice cuántos segundos esperar', JSON.stringify(third.body));

  const mismatched = await call('/rpc/hit_rate_limit', {
    method: 'POST', key: SECRET, body: { p_key: key, p_window_seconds: [60, 86400], p_limits: [2] },
  });
  record(mismatched.status >= 400, 'hit_rate_limit rechaza ventanas sin su límite', `HTTP ${mismatched.status}`);
}

// ─── Limpieza ────────────────────────────────────────────────────────────────
console.log('\nLimpieza');
{
  // La caché de plataformas cae en cascada con los títulos de prueba.
  const a = await call(`/content?title=like.__verify__*`, { method: 'DELETE', key: SECRET });
  const b = await call(`/conversations?user_id=is.null`, { method: 'DELETE', key: SECRET });
  const c = await call(`/rate_limits?key=like.__verify__*`, { method: 'DELETE', key: SECRET });
  record(a.status < 300 && b.status < 300 && c.status < 300, 'datos de prueba borrados',
    `HTTP ${a.status}/${b.status}/${c.status}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} comprobaciones correctas`);
if (failed.length > 0) {
  console.log('\nFallos:');
  for (const f of failed) console.log(`  ✗ ${f.label} — ${f.detail}`);
  process.exit(1);
}
console.log('Esquema verificado.\n');
