export interface Env {
  DB: D1Database;
  ADMIN_KEY?: string;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-device-id, x-admin-key',
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

const MS_PER_DAY = 86_400_000;

// 與 index.html 的 EMAIL_RE 保持同步
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Convert a local date string ("YYYY-MM-DD") to a UTC [since, until) range.
// tzOffset: minutes east of UTC (e.g. 480 for UTC+8)
function localDateToUtcRange(dateStr: string, tzOffset: number): [string, string] {
  const offsetMs = tzOffset * 60_000;
  const localMidnightAsUtc = Date.parse(`${dateStr}T00:00:00.000Z`);
  return [
    new Date(localMidnightAsUtc - offsetMs).toISOString(),
    new Date(localMidnightAsUtc - offsetMs + MS_PER_DAY).toISOString(),
  ];
}

// 每次 request 順手更新裝置的「上次開啟」中繼資料（不阻塞回應）
function touchDevice(env: Env, ctx: ExecutionContext, req: Request, deviceId: string): void {
  const ip = req.headers.get('CF-Connecting-IP');
  const ua = req.headers.get('User-Agent');
  ctx.waitUntil(
    env.DB.prepare(`
      INSERT INTO device_settings (device_id, last_seen_at, last_ip, last_user_agent)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        last_seen_at    = excluded.last_seen_at,
        last_ip         = COALESCE(excluded.last_ip, last_ip),
        last_user_agent = COALESCE(excluded.last_user_agent, last_user_agent)
    `).bind(deviceId, new Date().toISOString(), ip, ua).run().catch(() => {})
  );
}

// last_smoked_at 快照的唯一重算入口：任何會移除 log 的路徑都應呼叫這裡
async function syncLastSmokedFromLogs(env: Env, deviceId: string): Promise<void> {
  await env.DB.prepare(`
    UPDATE device_settings
    SET last_smoked_at = (SELECT MAX(smoked_at) FROM smoke_logs WHERE device_id = ?)
    WHERE device_id = ?
  `).bind(deviceId, deviceId).run();
}

// ── Share codes ──────────────────────────────────────────────────────────────
// 排除易混淆字元（I/L/O/0/1）
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map(b => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

async function activeShareCode(env: Env, deviceId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT code FROM share_codes WHERE device_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1'
  ).bind(deviceId).first<{ code: string }>();
  return row?.code ?? null;
}

// 一個裝置同時只有一組有效碼：已存在就直接回傳
async function createShareCode(env: Env, deviceId: string): Promise<string> {
  const existing = await activeShareCode(env, deviceId);
  if (existing) return existing;
  for (let i = 0; i < 5; i++) {
    const code = randomCode();
    try {
      await env.DB.prepare(
        'INSERT INTO share_codes (code, device_id, created_at) VALUES (?, ?, ?)'
      ).bind(code, deviceId, new Date().toISOString()).run();
      return code;
    } catch {
      // 可能是 code 撞號，也可能是同裝置並發產碼（撞 idx_share_one_active）
      // → 先查是否已有有效碼，有就直接用它
      const nowActive = await activeShareCode(env, deviceId);
      if (nowActive) return nowActive;
    }
  }
  throw new Error('Failed to generate share code');
}

async function revokeShareCodes(env: Env, deviceId: string): Promise<void> {
  await env.DB.prepare(
    'UPDATE share_codes SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL'
  ).bind(new Date().toISOString(), deviceId).run();
}

// ── User Handlers ─────────────────────────────────────────────────────────────

async function handleAddSmoke(req: Request, env: Env, deviceId: string): Promise<Response> {
  const body = await req.json<{ smoked_at?: string }>();
  const smokedAt = body.smoked_at ?? new Date().toISOString();

  if (Number.isNaN(Date.parse(smokedAt))) {
    return json({ error: 'Invalid smoked_at' }, 400);
  }

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO smoke_logs (device_id, smoked_at) VALUES (?, ?)'
    ).bind(deviceId, smokedAt),
    // 同步快照，成就計算不依賴 smoke_logs
    env.DB.prepare(`
      INSERT INTO device_settings (device_id, last_smoked_at) VALUES (?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        last_smoked_at = MAX(COALESCE(last_smoked_at, ''), excluded.last_smoked_at)
    `).bind(deviceId, smokedAt),
  ]);

  return json({ ok: true, smoked_at: smokedAt });
}

async function handleGetToday(env: Env, deviceId: string, date: string, tzOffset: number): Promise<Response> {
  const [since, until] = localDateToUtcRange(date, tzOffset);

  const { results } = await env.DB.prepare(
    'SELECT smoked_at FROM smoke_logs WHERE device_id = ? AND smoked_at >= ? AND smoked_at < ? ORDER BY smoked_at ASC'
  ).bind(deviceId, since, until).all<{ smoked_at: string }>();

  return json({ records: results.map(r => r.smoked_at) });
}

async function monthlyDailyCounts(env: Env, deviceId: string, month: string, tzOffset: number): Promise<Record<string, number>> {
  const offsetMs = tzOffset * 60_000;
  const [y, m] = month.split('-').map(Number);
  const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const since = new Date(Date.parse(`${month}-01T00:00:00.000Z`) - offsetMs).toISOString();
  const until = new Date(Date.parse(`${nextMonth}-01T00:00:00.000Z`) - offsetMs).toISOString();

  const { results } = await env.DB.prepare(
    'SELECT smoked_at FROM smoke_logs WHERE device_id = ? AND smoked_at >= ? AND smoked_at < ? ORDER BY smoked_at ASC'
  ).bind(deviceId, since, until).all<{ smoked_at: string }>();

  const counts: Record<string, number> = {};
  for (const { smoked_at } of results) {
    const localDay = new Date(Date.parse(smoked_at) + offsetMs).toISOString().slice(0, 10);
    counts[localDay] = (counts[localDay] ?? 0) + 1;
  }
  return counts;
}

async function handleDailyStats(req: Request, env: Env, deviceId: string): Promise<Response> {
  const url = new URL(req.url);
  const month = url.searchParams.get('month'); // YYYY-MM
  const tzOffset = Number.parseInt(url.searchParams.get('tz_offset') ?? '0', 10);
  if (!month) return json({ error: 'Missing month' }, 400);

  const counts = await monthlyDailyCounts(env, deviceId, month, tzOffset);
  return json({ month, counts });
}

async function handleGetSettings(env: Env, deviceId: string): Promise<Response> {
  const row = await env.DB.prepare(
    'SELECT cooldown_hours, nickname, email FROM device_settings WHERE device_id = ?'
  ).bind(deviceId).first<{ cooldown_hours: number; nickname: string | null; email: string | null }>();

  return json({
    cooldown_hours: row?.cooldown_hours ?? 1,
    nickname: row?.nickname ?? null,
    email: row?.email ?? null,
  });
}

async function handleUpdateSettings(req: Request, env: Env, deviceId: string): Promise<Response> {
  const body = await req.json<{ cooldown_hours?: number; nickname?: string | null; email?: string | null }>();

  if (body.cooldown_hours !== undefined) {
    if (typeof body.cooldown_hours !== 'number' || body.cooldown_hours < 0) {
      return json({ error: 'cooldown_hours must be >= 0' }, 400);
    }
  }

  let nickname: string | null | undefined = undefined;
  if (body.nickname !== undefined) {
    if (body.nickname !== null && typeof body.nickname !== 'string') {
      return json({ error: 'nickname must be a string' }, 400);
    }
    nickname = body.nickname?.trim().slice(0, 20) || null;
  }

  let email: string | null | undefined = undefined;
  if (body.email !== undefined) {
    if (body.email !== null && typeof body.email !== 'string') {
      return json({ error: 'email must be a string' }, 400);
    }
    const trimmed = body.email?.trim() || null;
    if (trimmed && !EMAIL_RE.test(trimmed)) {
      return json({ error: 'Invalid email' }, 400);
    }
    email = trimmed ? trimmed.slice(0, 254) : null;
  }

  // 先確保列存在，再只更新有提供的欄位（單一 batch，原子執行）
  const stmts = [
    env.DB.prepare('INSERT OR IGNORE INTO device_settings (device_id) VALUES (?)').bind(deviceId),
  ];
  if (body.cooldown_hours !== undefined) {
    stmts.push(env.DB.prepare(
      'UPDATE device_settings SET cooldown_hours = ? WHERE device_id = ?'
    ).bind(body.cooldown_hours, deviceId));
  }
  if (nickname !== undefined) {
    stmts.push(env.DB.prepare(
      'UPDATE device_settings SET nickname = ? WHERE device_id = ?'
    ).bind(nickname, deviceId));
  }
  if (email !== undefined) {
    stmts.push(env.DB.prepare(
      'UPDATE device_settings SET email = ? WHERE device_id = ?'
    ).bind(email, deviceId));
  }
  await env.DB.batch(stmts);

  return json({ ok: true });
}

// ── Achievements ─────────────────────────────────────────────────────────────

const BADGES = [
  { badge: '1m', days: 30, label: '1 個月', icon: '🥉' },
  { badge: '3m', days: 90, label: '3 個月', icon: '🥈' },
  { badge: '6m', days: 180, label: '半年', icon: '🥇' },
] as const;

async function settleAchievements(env: Env, deviceId: string): Promise<{
  last_smoked_at: string | null;
  streak_days: number | null;
  badges: { badge: string; earned_at: string }[];
  thresholds: typeof BADGES;
}> {
  const row = await env.DB.prepare(
    'SELECT last_smoked_at FROM device_settings WHERE device_id = ?'
  ).bind(deviceId).first<{ last_smoked_at: string | null }>();

  const lastSmokedAt = row?.last_smoked_at ?? null;
  let streakDays: number | null = null;

  if (lastSmokedAt) {
    streakDays = Math.floor((Date.now() - Date.parse(lastSmokedAt)) / MS_PER_DAY);

    // 達標的徽章寫入（永久保留，破戒不沒收）
    const earnedNow = BADGES.filter(b => streakDays! >= b.days);
    if (earnedNow.length > 0) {
      const lastMs = Date.parse(lastSmokedAt);
      await env.DB.batch(earnedNow.map(b =>
        env.DB.prepare(
          'INSERT OR IGNORE INTO achievements (device_id, badge, earned_at) VALUES (?, ?, ?)'
        ).bind(deviceId, b.badge, new Date(lastMs + b.days * MS_PER_DAY).toISOString())
      ));
    }
  }

  const { results } = await env.DB.prepare(
    'SELECT badge, earned_at FROM achievements WHERE device_id = ?'
  ).bind(deviceId).all<{ badge: string; earned_at: string }>();

  return {
    last_smoked_at: lastSmokedAt,
    streak_days: streakDays,
    badges: results,
    thresholds: BADGES,
  };
}

async function handleAchievements(env: Env, deviceId: string): Promise<Response> {
  return json(await settleAchievements(env, deviceId));
}

// ── Share / Watch handlers ───────────────────────────────────────────────────

async function handleGetShare(env: Env, deviceId: string): Promise<Response> {
  return json({ code: await activeShareCode(env, deviceId) });
}

async function handleCreateShare(env: Env, deviceId: string): Promise<Response> {
  return json({ code: await createShareCode(env, deviceId) });
}

async function handleRevokeShare(env: Env, deviceId: string): Promise<Response> {
  await revokeShareCodes(env, deviceId);
  return json({ ok: true });
}

// 監護人視角：憑分享碼唯讀查看。只露統計、設定與成就，不露 device_id / IP / UA / 信箱。
async function handleWatch(req: Request, env: Env, rawCode: string): Promise<Response> {
  const code = rawCode.trim().toUpperCase();
  const row = await env.DB.prepare(
    'SELECT device_id FROM share_codes WHERE code = ? AND revoked_at IS NULL'
  ).bind(code).first<{ device_id: string }>();
  if (!row) return json({ error: 'Invalid or revoked code' }, 404);
  const deviceId = row.device_id;

  const url = new URL(req.url);
  const tzOffset = Number.parseInt(url.searchParams.get('tz_offset') ?? '0', 10);
  const date = url.searchParams.get('date');   // 監護人時區的今天 YYYY-MM-DD

  const [settings, achievements] = await Promise.all([
    env.DB.prepare(
      'SELECT nickname, cooldown_hours FROM device_settings WHERE device_id = ?'
    ).bind(deviceId).first<{ nickname: string | null; cooldown_hours: number }>(),
    settleAchievements(env, deviceId),
  ]);

  let todayCount = 0;
  if (date) {
    const [since, until] = localDateToUtcRange(date, tzOffset);
    const r = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM smoke_logs WHERE device_id = ? AND smoked_at >= ? AND smoked_at < ?'
    ).bind(deviceId, since, until).first<{ n: number }>();
    todayCount = r?.n ?? 0;
  }

  const stats = await buildUserStats(env, deviceId, tzOffset);

  return json({
    nickname: settings?.nickname ?? null,
    cooldown_hours: settings?.cooldown_hours ?? 1,
    last_smoked_at: achievements.last_smoked_at,
    streak_days: achievements.streak_days,
    badges: achievements.badges,
    thresholds: achievements.thresholds,
    today_count: todayCount,
    ...stats,
  });
}

// ── Delete handlers ──────────────────────────────────────────────────────────

async function handleDeleteSmoke(req: Request, env: Env, deviceId: string): Promise<Response> {
  const body = await req.json<{ smoked_at: string }>();
  if (!body.smoked_at) return json({ error: 'Missing smoked_at' }, 400);

  const { meta } = await env.DB.prepare(
    'DELETE FROM smoke_logs WHERE device_id = ? AND smoked_at = ?'
  ).bind(deviceId, body.smoked_at).run();

  // 快照跟著 logs 重算（刪的可能是最後一筆）
  await syncLastSmokedFromLogs(env, deviceId);

  return json({ ok: true, deleted: meta.changes });
}

async function handleDeleteAll(env: Env, deviceId: string): Promise<Response> {
  // 只清 logs，保留 last_smoked_at 快照——戒菸天數與成就不因清理歷史而消失
  await env.DB.prepare('DELETE FROM smoke_logs WHERE device_id = ?').bind(deviceId).run();
  return json({ ok: true });
}

async function handleExport(req: Request, env: Env, deviceId: string): Promise<Response> {
  const body = await req.json<{ tz_offset?: number }>();
  const tzOffset = body.tz_offset ?? 0;
  const offsetMs = tzOffset * 60_000;

  const localNow = new Date(Date.now() + offsetMs);
  const year = localNow.getUTCFullYear();
  const since = new Date(Date.parse(`${year}-01-01T00:00:00.000Z`) - offsetMs).toISOString();
  const until = new Date(Date.parse(`${year + 1}-01-01T00:00:00.000Z`) - offsetMs).toISOString();

  const { results } = await env.DB.prepare(
    'SELECT smoked_at FROM smoke_logs WHERE device_id = ? AND smoked_at >= ? AND smoked_at < ? ORDER BY smoked_at ASC'
  ).bind(deviceId, since, until).all<{ smoked_at: string }>();

  const monthly: Record<string, number> = {};
  for (const { smoked_at } of results) {
    const localMonth = new Date(Date.parse(smoked_at) + offsetMs).toISOString().slice(0, 7);
    monthly[localMonth] = (monthly[localMonth] ?? 0) + 1;
  }

  return json({ year, monthly, total: results.length });
}

// ── Admin Handlers ────────────────────────────────────────────────────────────

function adminAuth(req: Request, env: Env): Response | null {
  if (!env.ADMIN_KEY) return json({ error: 'Admin not configured' }, 503);
  const key = req.headers.get('x-admin-key');
  if (key !== env.ADMIN_KEY) return json({ error: 'Unauthorized' }, 401);
  return null;
}

async function handleAdminStats(req: Request, env: Env): Promise<Response> {
  const authErr = adminAuth(req, env);
  if (authErr) return authErr;

  const url = new URL(req.url);
  const tzOffset = Number.parseInt(url.searchParams.get('tz_offset') ?? '0', 10);
  const days = Number.parseInt(url.searchParams.get('days') ?? '30', 10);
  const offsetMs = tzOffset * 60_000;
  const since = new Date(Date.now() - days * MS_PER_DAY).toISOString();

  const [overall, allLogs, recentLogs] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) as total, COUNT(DISTINCT device_id) as user_count FROM smoke_logs')
      .first<{ total: number; user_count: number }>(),
    env.DB.prepare('SELECT smoked_at FROM smoke_logs')
      .all<{ smoked_at: string }>(),
    env.DB.prepare('SELECT smoked_at FROM smoke_logs WHERE smoked_at >= ?')
      .bind(since).all<{ smoked_at: string }>(),
  ]);

  const hourly = new Array(24).fill(0);
  for (const { smoked_at } of allLogs.results) {
    hourly[new Date(Date.parse(smoked_at) + offsetMs).getUTCHours()]++;
  }

  const daily: Record<string, number> = {};
  for (const { smoked_at } of recentLogs.results) {
    const day = new Date(Date.parse(smoked_at) + offsetMs).toISOString().slice(0, 10);
    daily[day] = (daily[day] ?? 0) + 1;
  }

  return json({
    total_smokes: overall?.total ?? 0,
    user_count: overall?.user_count ?? 0,
    hourly_distribution: hourly,
    daily_trend: daily,
  });
}

async function handleAdminUsers(req: Request, env: Env): Promise<Response> {
  const authErr = adminAuth(req, env);
  if (authErr) return authErr;

  // 合併 device_settings（可能沒抽過）與 smoke_logs（可能沒 settings）
  const { results } = await env.DB.prepare(`
    WITH agg AS (
      SELECT device_id, COUNT(*) AS total,
             MIN(smoked_at) AS first_smoked_at,
             MAX(smoked_at) AS max_smoked_at
      FROM smoke_logs GROUP BY device_id
    )
    SELECT s.device_id, s.nickname, s.email, s.last_seen_at, s.last_ip, s.last_user_agent,
           COALESCE(a.total, 0) AS total,
           a.first_smoked_at,
           COALESCE(s.last_smoked_at, a.max_smoked_at) AS last_smoked_at
    FROM device_settings s
    LEFT JOIN agg a ON a.device_id = s.device_id
    UNION ALL
    SELECT a.device_id, NULL, NULL, NULL, NULL, NULL,
           a.total, a.first_smoked_at, a.max_smoked_at
    FROM agg a
    WHERE a.device_id NOT IN (SELECT device_id FROM device_settings)
    ORDER BY total DESC
  `).all();

  return json({ users: results });
}

// 單一使用者的完整統計（admin 詳細頁與監護人視角共用）
async function buildUserStats(env: Env, deviceId: string, tzOffset: number): Promise<{
  total: number;
  hourly_distribution: number[];
  monthly: Record<string, number>;
  logs: string[];
}> {
  const offsetMs = tzOffset * 60_000;
  const { results } = await env.DB.prepare(
    'SELECT smoked_at FROM smoke_logs WHERE device_id = ? ORDER BY smoked_at DESC'
  ).bind(deviceId).all<{ smoked_at: string }>();

  const hourly = new Array(24).fill(0);
  const monthly: Record<string, number> = {};
  for (const { smoked_at } of results) {
    const d = new Date(Date.parse(smoked_at) + offsetMs);
    hourly[d.getUTCHours()]++;
    const mk = d.toISOString().slice(0, 7);
    monthly[mk] = (monthly[mk] ?? 0) + 1;
  }

  return { total: results.length, hourly_distribution: hourly, monthly, logs: results.map(r => r.smoked_at) };
}

async function handleAdminUserDetail(req: Request, env: Env, deviceId: string): Promise<Response> {
  const authErr = adminAuth(req, env);
  if (authErr) return authErr;

  const url = new URL(req.url);
  const tzOffset = Number.parseInt(url.searchParams.get('tz_offset') ?? '0', 10);

  const [stats, settings, shareCode] = await Promise.all([
    buildUserStats(env, deviceId, tzOffset),
    env.DB.prepare(
      'SELECT nickname, email, cooldown_hours, last_seen_at, last_ip, last_user_agent FROM device_settings WHERE device_id = ?'
    ).bind(deviceId).first<{ nickname: string | null; email: string | null; cooldown_hours: number | null; last_seen_at: string | null; last_ip: string | null; last_user_agent: string | null }>(),
    activeShareCode(env, deviceId),
  ]);

  return json({
    device_id: deviceId,
    nickname: settings?.nickname ?? null,
    email: settings?.email ?? null,
    cooldown_hours: settings?.cooldown_hours ?? null,
    share_code: shareCode,
    last_seen_at: settings?.last_seen_at ?? null,
    last_ip: settings?.last_ip ?? null,
    last_user_agent: settings?.last_user_agent ?? null,
    ...stats,
  });
}

async function handleAdminDeleteUser(req: Request, env: Env, deviceId: string): Promise<Response> {
  const authErr = adminAuth(req, env);
  if (authErr) return authErr;

  const results = await env.DB.batch([
    env.DB.prepare('DELETE FROM smoke_logs WHERE device_id = ?').bind(deviceId),
    env.DB.prepare('DELETE FROM device_settings WHERE device_id = ?').bind(deviceId),
    env.DB.prepare('DELETE FROM achievements WHERE device_id = ?').bind(deviceId),
    env.DB.prepare('DELETE FROM share_codes WHERE device_id = ?').bind(deviceId),
  ]);

  return json({ ok: true, deleted_logs: results[0].meta.changes });
}

// admin 可代為產生分享碼（抽菸的人不主動分享時，由管理者發碼給家人）
async function handleAdminCreateShare(req: Request, env: Env, deviceId: string): Promise<Response> {
  const authErr = adminAuth(req, env);
  if (authErr) return authErr;
  return json({ code: await createShareCode(env, deviceId) });
}

async function handleAdminRevokeShare(req: Request, env: Env, deviceId: string): Promise<Response> {
  const authErr = adminAuth(req, env);
  if (authErr) return authErr;
  await revokeShareCodes(env, deviceId);
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
  'GET /achievements':       (_req, env, id) => handleAchievements(env, id),
  'GET /share':              (_req, env, id) => handleGetShare(env, id),
  'POST /share':             (_req, env, id) => handleCreateShare(env, id),
  'DELETE /share':           (_req, env, id) => handleRevokeShare(env, id),
  'POST /export':            (req, env, id) => handleExport(req, env, id),
};

async function routeAdmin(request: Request, env: Env, path: string, method: string): Promise<Response> {
  if (method === 'GET' && path === '/admin/stats') return handleAdminStats(request, env);
  if (method === 'GET' && path === '/admin/users') return handleAdminUsers(request, env);
  const userMatch = /^\/admin\/users\/([^/]+)$/.exec(path);
  if (userMatch && method === 'GET') return handleAdminUserDetail(request, env, decodeURIComponent(userMatch[1]));
  if (userMatch && method === 'DELETE') return handleAdminDeleteUser(request, env, decodeURIComponent(userMatch[1]));
  const shareMatch = /^\/admin\/users\/([^/]+)\/share-code$/.exec(path);
  if (shareMatch && method === 'POST') return handleAdminCreateShare(request, env, decodeURIComponent(shareMatch[1]));
  if (shareMatch && method === 'DELETE') return handleAdminRevokeShare(request, env, decodeURIComponent(shareMatch[1]));
  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === '/health') return json({ ok: true });
    if (path.startsWith('/admin')) return routeAdmin(request, env, path, method);

    // 監護人端點：憑分享碼授權，不需要 x-device-id，也不更新被看者的 last_seen
    const watchMatch = /^\/watch\/([^/]+)$/.exec(path);
    if (method === 'GET' && watchMatch) return handleWatch(request, env, decodeURIComponent(watchMatch[1]));

    const deviceId = deviceIdFrom(request);
    if (!deviceId) return json({ error: 'Missing x-device-id header' }, 400);

    touchDevice(env, ctx, request, deviceId);

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
