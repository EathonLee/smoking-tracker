export interface Env {
  DB: D1Database;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-device-id',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function deviceIdFrom(req: Request): string | null {
  return req.headers.get('x-device-id');
}

// Convert a local date string ("YYYY-MM-DD") to a UTC [since, until) range.
// tzOffset: minutes east of UTC (e.g. 480 for UTC+8)
function localDateToUtcRange(dateStr: string, tzOffset: number): [string, string] {
  const offsetMs = tzOffset * 60_000;
  const localMidnightAsUtc = Date.parse(`${dateStr}T00:00:00.000Z`);
  return [
    new Date(localMidnightAsUtc - offsetMs).toISOString(),
    new Date(localMidnightAsUtc - offsetMs + 86_400_000).toISOString(),
  ];
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleAddSmoke(req: Request, env: Env, deviceId: string): Promise<Response> {
  const body = await req.json<{ smoked_at?: string }>();
  const smokedAt = body.smoked_at ?? new Date().toISOString();

  if (Number.isNaN(Date.parse(smokedAt))) {
    return json({ error: 'Invalid smoked_at' }, 400);
  }

  await env.DB.prepare(
    'INSERT INTO smoke_logs (device_id, smoked_at) VALUES (?, ?)'
  ).bind(deviceId, smokedAt).run();

  return json({ ok: true, smoked_at: smokedAt });
}

async function handleGetToday(env: Env, deviceId: string, date: string, tzOffset: number): Promise<Response> {
  const [since, until] = localDateToUtcRange(date, tzOffset);

  const { results } = await env.DB.prepare(
    'SELECT smoked_at FROM smoke_logs WHERE device_id = ? AND smoked_at >= ? AND smoked_at < ? ORDER BY smoked_at ASC'
  ).bind(deviceId, since, until).all<{ smoked_at: string }>();

  return json({ records: results.map(r => r.smoked_at) });
}

async function handleDailyStats(req: Request, env: Env, deviceId: string): Promise<Response> {
  const url = new URL(req.url);
  const month = url.searchParams.get('month'); // YYYY-MM
  const tzOffset = Number.parseInt(url.searchParams.get('tz_offset') ?? '0', 10);
  if (!month) return json({ error: 'Missing month' }, 400);

  const offsetMs = tzOffset * 60_000;
  // Local month boundaries → UTC range
  const [y, m] = month.split('-').map(Number);
  const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const since = new Date(Date.parse(`${month}-01T00:00:00.000Z`) - offsetMs).toISOString();
  const until = new Date(Date.parse(`${nextMonth}-01T00:00:00.000Z`) - offsetMs).toISOString();

  const { results } = await env.DB.prepare(
    'SELECT smoked_at FROM smoke_logs WHERE device_id = ? AND smoked_at >= ? AND smoked_at < ? ORDER BY smoked_at ASC'
  ).bind(deviceId, since, until).all<{ smoked_at: string }>();

  // Bucket by local date
  const counts: Record<string, number> = {};
  for (const { smoked_at } of results) {
    const localDay = new Date(Date.parse(smoked_at) + offsetMs).toISOString().slice(0, 10);
    counts[localDay] = (counts[localDay] ?? 0) + 1;
  }

  return json({ month, counts });
}

async function handleGetSettings(env: Env, deviceId: string): Promise<Response> {
  const row = await env.DB.prepare(
    'SELECT cooldown_hours FROM device_settings WHERE device_id = ?'
  ).bind(deviceId).first<{ cooldown_hours: number }>();

  return json({ cooldown_hours: row?.cooldown_hours ?? 1 });
}

async function handleUpdateSettings(req: Request, env: Env, deviceId: string): Promise<Response> {
  const body = await req.json<{ cooldown_hours?: number }>();

  if (body.cooldown_hours !== undefined) {
    if (typeof body.cooldown_hours !== 'number' || body.cooldown_hours < 0) {
      return json({ error: 'cooldown_hours must be >= 0' }, 400);
    }
  }

  await env.DB.prepare(`
    INSERT INTO device_settings (device_id, cooldown_hours)
    VALUES (?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      cooldown_hours = COALESCE(excluded.cooldown_hours, cooldown_hours)
  `).bind(deviceId, body.cooldown_hours ?? null).run();

  return json({ ok: true });
}

async function handleExport(req: Request, env: Env, deviceId: string): Promise<Response> {
  const body = await req.json<{ tz_offset?: number }>();
  const tzOffset = body.tz_offset ?? 0;
  const offsetMs = tzOffset * 60_000;

  // Local year boundaries → UTC range
  const localNow = new Date(Date.now() + offsetMs);
  const year = localNow.getUTCFullYear();
  const since = new Date(Date.parse(`${year}-01-01T00:00:00.000Z`) - offsetMs).toISOString();
  const until = new Date(Date.parse(`${year + 1}-01-01T00:00:00.000Z`) - offsetMs).toISOString();

  const { results } = await env.DB.prepare(
    'SELECT smoked_at FROM smoke_logs WHERE device_id = ? AND smoked_at >= ? AND smoked_at < ? ORDER BY smoked_at ASC'
  ).bind(deviceId, since, until).all<{ smoked_at: string }>();

  // Bucket by local month
  const monthly: Record<string, number> = {};
  for (const { smoked_at } of results) {
    const localMonth = new Date(Date.parse(smoked_at) + offsetMs).toISOString().slice(0, 7);
    monthly[localMonth] = (monthly[localMonth] ?? 0) + 1;
  }

  return json({ year, monthly, total: results.length });
}

async function handleDeleteSmoke(req: Request, env: Env, deviceId: string): Promise<Response> {
  const body = await req.json<{ smoked_at: string }>();
  if (!body.smoked_at) return json({ error: 'Missing smoked_at' }, 400);

  const { meta } = await env.DB.prepare(
    'DELETE FROM smoke_logs WHERE device_id = ? AND smoked_at = ?'
  ).bind(deviceId, body.smoked_at).run();

  return json({ ok: true, deleted: meta.changes });
}

async function handleDeleteAll(env: Env, deviceId: string): Promise<Response> {
  await env.DB.prepare('DELETE FROM smoke_logs WHERE device_id = ?').bind(deviceId).run();
  return json({ ok: true });
}

// ── Router ────────────────────────────────────────────────────────────────────

type Handler = (req: Request, env: Env, deviceId: string) => Promise<Response>;

const routes: Record<string, Handler> = {
  'POST /smoke':             (req, env, id) => handleAddSmoke(req, env, id),
  'DELETE /smoke':           (req, env, id) => handleDeleteSmoke(req, env, id),
  'DELETE /smoke/all':       (_req, env, id) => handleDeleteAll(env, id),
  'GET /smoke/stats/daily':  (req, env, id) => handleDailyStats(req, env, id),
  'GET /settings':           (_req, env, id) => handleGetSettings(env, id),
  'PUT /settings':           (req, env, id) => handleUpdateSettings(req, env, id),
  'POST /export':            (req, env, id) => handleExport(req, env, id),
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === '/health') return json({ ok: true });

    const deviceId = deviceIdFrom(request);
    if (!deviceId) return json({ error: 'Missing x-device-id header' }, 400);

    if (method === 'GET' && path === '/smoke/today') {
      const date = url.searchParams.get('date');
      const tzOffset = Number.parseInt(url.searchParams.get('tz_offset') ?? '0', 10);
      if (!date) return json({ error: 'Missing date' }, 400);
      return handleGetToday(env, deviceId, date, tzOffset);
    }

    const handler = routes[`${method} ${path}`];
    if (handler) return handler(request, env, deviceId);

    return json({ error: 'Not found' }, 404);
  },
};
