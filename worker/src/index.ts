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

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleAddSmoke(req: Request, env: Env, deviceId: string): Promise<Response> {
  const body = await req.json<{ smoked_at?: string }>();
  const smokedAt = body.smoked_at ?? new Date().toISOString();

  // Validate ISO string
  if (isNaN(Date.parse(smokedAt))) {
    return json({ error: 'Invalid smoked_at' }, 400);
  }

  await env.DB.prepare(
    'INSERT INTO smoke_logs (device_id, smoked_at) VALUES (?, ?)'
  ).bind(deviceId, smokedAt).run();

  return json({ ok: true, smoked_at: smokedAt });
}

async function handleGetTodayWithDate(env: Env, deviceId: string, date: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT smoked_at FROM smoke_logs WHERE device_id = ? AND smoked_at LIKE ? ORDER BY smoked_at ASC"
  ).bind(deviceId, `${date}%`).all<{ smoked_at: string }>();

  return json({ records: results.map(r => r.smoked_at) });
}

async function handleHourlyStats(req: Request, env: Env, deviceId: string): Promise<Response> {
  const url = new URL(req.url);
  const date = url.searchParams.get('date'); // YYYY-MM-DD
  if (!date) return json({ error: 'Missing date' }, 400);

  const { results } = await env.DB.prepare(
    "SELECT smoked_at FROM smoke_logs WHERE device_id = ? AND smoked_at LIKE ? ORDER BY smoked_at ASC"
  ).bind(deviceId, `${date}%`).all<{ smoked_at: string }>();

  // Aggregate by hour (0–23)
  const counts = Array(24).fill(0) as number[];
  for (const { smoked_at } of results) {
    const hour = new Date(smoked_at).getUTCHours();
    counts[hour]++;
  }

  return json({ date, counts });
}

async function handleDailyStats(req: Request, env: Env, deviceId: string): Promise<Response> {
  const url = new URL(req.url);
  const month = url.searchParams.get('month'); // YYYY-MM
  if (!month) return json({ error: 'Missing month' }, 400);

  const { results } = await env.DB.prepare(
    "SELECT smoked_at FROM smoke_logs WHERE device_id = ? AND smoked_at LIKE ? ORDER BY smoked_at ASC"
  ).bind(deviceId, `${month}%`).all<{ smoked_at: string }>();

  // Aggregate by day (YYYY-MM-DD)
  const counts: Record<string, number> = {};
  for (const { smoked_at } of results) {
    const day = smoked_at.slice(0, 10);
    counts[day] = (counts[day] ?? 0) + 1;
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

async function handleExport(_req: Request, env: Env, deviceId: string): Promise<Response> {
  const year = new Date().getUTCFullYear();

  const { results } = await env.DB.prepare(
    "SELECT smoked_at FROM smoke_logs WHERE device_id = ? AND smoked_at LIKE ? ORDER BY smoked_at ASC"
  ).bind(deviceId, `${year}%`).all<{ smoked_at: string }>();

  const monthly: Record<string, number> = {};
  for (const { smoked_at } of results) {
    const month = smoked_at.slice(0, 7);
    monthly[month] = (monthly[month] ?? 0) + 1;
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
  'POST /smoke':              (req, env, id) => handleAddSmoke(req, env, id),
  'DELETE /smoke':            (req, env, id) => handleDeleteSmoke(req, env, id),
  'DELETE /smoke/all':        (_req, env, id) => handleDeleteAll(env, id),
  'GET /smoke/stats/hourly':  (req, env, id) => handleHourlyStats(req, env, id),
  'GET /smoke/stats/daily':   (req, env, id) => handleDailyStats(req, env, id),
  'GET /settings':            (_req, env, id) => handleGetSettings(env, id),
  'PUT /settings':            (req, env, id) => handleUpdateSettings(req, env, id),
  'POST /export':             (req, env, id) => handleExport(req, env, id),
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
      if (!date) return json({ error: 'Missing date' }, 400);
      return handleGetTodayWithDate(env, deviceId, date);
    }

    const handler = routes[`${method} ${path}`];
    if (handler) return handler(request, env, deviceId);

    return json({ error: 'Not found' }, 404);
  },
};
