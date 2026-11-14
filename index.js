require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);
const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || false }));
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- تسجيل الدخول والصلاحيات ----------
app.set('trust proxy', 1);
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) console.warn('⚠️ ضيف SESSION_SECRET (وإلا الجلسات هتتلغي مع كل إعادة تشغيل)');
const SECURE = process.env.NODE_ENV === 'production' || !!process.env.RENDER;

const hash = p => { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(p, s, 64).toString('hex'); };
const verify = (p, h) => { const [s, k] = String(h).split(':'); const a = Buffer.from(k || '', 'hex'), b = crypto.scryptSync(p, s || '', 64); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const sign = d => { const b = Buffer.from(JSON.stringify(d)).toString('base64url'); return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url'); };
const unsign = t => {
  const [b, m] = String(t || '').split('.');
  if (!b || !m) return null;
  const e = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  if (m.length !== e.length || !crypto.timingSafeEqual(Buffer.from(m), Buffer.from(e))) return null;
  try { const d = JSON.parse(Buffer.from(b, 'base64url')); return d.e > Date.now() ? d : null; } catch { return null; }
};
const getCookie = (req, n) => {
  for (const c of (req.headers.cookie || '').split(';')) {
    const i = c.indexOf('=');
    if (c.slice(0, i).trim() === n) return c.slice(i + 1).trim();
  }
  return '';
};
const setSession = (res, value, age) => res.setHeader('Set-Cookie', `sid=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${SECURE ? '; Secure' : ''}`);

const tries = new Map(); // حماية من تخمين كلمات السر
app.post('/api/login', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase(), password = String(req.body.password || '');
  const k = req.ip + '|' + username, t = tries.get(k) || { n: 0, until: 0 };
  if (Date.now() < t.until) return res.status(429).json({ error: 'محاولات كتير، حاول بعد 15 دقيقة' });
  const [u] = await sql`SELECT username, role, pw FROM users WHERE username = ${username} AND active`;
  if (!u || !verify(password, u.pw)) {
    if (++t.n >= 8) { t.until = Date.now() + 15 * 60e3; t.n = 0; }
    tries.set(k, t);
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة السر غير صحيحة' });
  }
  tries.delete(k);
  setSession(res, sign({ u: u.username, e: Date.now() + 12 * 3600e3 }), 43200);
  res.json({ username: u.username, role: u.role });
});
app.post('/api/logout', (req, res) => { setSession(res, '', 0); res.json({ success: true }); });

app.use('/api', async (req, res, next) => { // لازم تسجيل دخول لأي حاجة بعد كده
  const d = unsign(getCookie(req, 'sid'));
  if (d) {
    const [u] = await sql`SELECT username, role FROM users WHERE username = ${d.u} AND active`;
    if (u) { req.user = u; return next(); }
  }
  res.status(401).json({ error: 'سجّل الدخول' });
});
app.get('/api/me', (req, res) => res.json(req.user));
app.use('/api', (req, res, next) => { // المستخدم العادي: تقارير وقائمة الموظفين (قراءة فقط)
  const ok = req.user.role === 'admin' || (req.method === 'GET' && ['/report', '/employees'].includes(req.path));
  ok ? next() : res.status(403).json({ error: 'مش مسموح لك بالعملية دي' });
});

const norm = s => String(s ?? '').trim().replace(/^0+(?=\d)/, ''); // 0012 = 12
const clean = s => String(s ?? '').trim() || null;
const bad = (res, msg) => res.status(400).json({ error: msg });
const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

async function init() {
  await sql`CREATE TABLE IF NOT EXISTS employees (code text PRIMARY KEY, name text NOT NULL, dept text)`;
  await sql`CREATE TABLE IF NOT EXISTS punch_files (id serial PRIMARY KEY, name text NOT NULL, rows_total int, rows_new int, uploaded_at timestamptz DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS punches (id bigserial PRIMARY KEY, file_id int REFERENCES punch_files(id) ON DELETE CASCADE, emp_code text NOT NULL, punch_time timestamp NOT NULL, UNIQUE (emp_code, punch_time))`;
  await sql`CREATE TABLE IF NOT EXISTS users (username text PRIMARY KEY, pw text NOT NULL, role text NOT NULL DEFAULT 'viewer', active boolean NOT NULL DEFAULT true, created_at timestamptz DEFAULT now())`;
  const au = String(process.env.ADMIN_USER || '').trim().toLowerCase(), ap = process.env.ADMIN_PASSWORD;
  if (au && ap) await sql`INSERT INTO users (username, pw, role) VALUES (${au}, ${hash(ap)}, 'admin') ON CONFLICT DO NOTHING`;
  else if (!(await sql`SELECT 1 FROM users LIMIT 1`).length) console.warn('⚠️ مفيش مستخدمين: ضيف ADMIN_USER و ADMIN_PASSWORD');
}

// ---------- الموظفين ----------
async function upsertEmployees(list) {
  const m = new Map();
  for (const r of list) {
    const code = norm(r.code), name = String(r.name ?? '').trim();
    if (code && name) m.set(code, { code, name, dept: clean(r.dept) });
  }
  const a = [...m.values()];
  if (a.length) {
    await sql`INSERT INTO employees (code, name, dept)
      SELECT * FROM unnest(${a.map(x => x.code)}::text[], ${a.map(x => x.name)}::text[], ${a.map(x => x.dept)}::text[])
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, dept = EXCLUDED.dept`;
  }
  return a.length;
}

app.get('/api/employees', async (req, res) => {
  res.json(await sql`SELECT code, name, dept FROM employees ORDER BY length(code), code`);
});
app.post('/api/employees', async (req, res) => {
  if (!(await upsertEmployees([req.body]))) return bad(res, 'الكود والاسم مطلوبين');
  res.json({ success: true });
});
app.post('/api/employees/bulk', async (req, res) => {
  res.json({ count: await upsertEmployees(req.body.rows || []) });
});
app.delete('/api/employees/:code', async (req, res) => {
  await sql`DELETE FROM employees WHERE code = ${norm(req.params.code)}`;
  res.json({ success: true });
});

// ---------- ملفات البصمة ----------
app.get('/api/files', async (req, res) => {
  res.json(await sql`SELECT id, name, rows_total, rows_new,
    to_char(uploaded_at AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD HH24:MI') AS uploaded
    FROM punch_files ORDER BY id DESC`);
});

app.post('/api/files', async (req, res) => {
  const name = String(req.body.name || 'file');
  const seen = new Set(), rows = [];
  for (const r of req.body.rows || []) {
    const code = norm(r.code), time = String(r.time);
    if (!code || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(time)) continue;
    const k = code + '|' + time;
    if (seen.has(k)) continue; // تكرار جوه نفس الملف
    seen.add(k);
    rows.push([code, time]);
  }
  if (!rows.length) return bad(res, 'مفيش بصمات صالحة في الملف');

  const [f] = await sql`INSERT INTO punch_files (name, rows_total, rows_new) VALUES (${name}, ${rows.length}, 0) RETURNING id`;
  let added = 0;
  for (let i = 0; i < rows.length; i += 5000) {
    const c = rows.slice(i, i + 5000);
    // نفس الكود في نفس الدقيقة = مكرر ويتتجاهل (حتى لو في ملف تاني)
    const r = await sql`INSERT INTO punches (file_id, emp_code, punch_time)
      SELECT ${f.id}::int, x.c, x.t::timestamp
      FROM unnest(${c.map(x => x[0])}::text[], ${c.map(x => x[1])}::text[]) AS x(c, t)
      ON CONFLICT DO NOTHING RETURNING id`;
    added += r.length;
  }
  await sql`UPDATE punch_files SET rows_new = ${added} WHERE id = ${f.id}`;
  res.json({ total: rows.length, added, duplicates: rows.length - added });
});

app.delete('/api/files/:id', async (req, res) => {
  await sql`DELETE FROM punch_files WHERE id = ${Number(req.params.id)}`; // بيمسح بصماته (CASCADE)
  res.json({ success: true });
});

// ---------- التقارير ----------
app.get('/api/report', async (req, res) => {
  const { from, to, kind } = req.query;
  const dept = String(req.query.dept || ''), scope = String(req.query.scope || 'all'), code = norm(req.query.code);
  if (!isDay(from) || !isDay(to)) return bad(res, 'التاريخ غير صحيح');

  if (kind === 'punches') {
    return res.json(await sql`
      SELECT p.emp_code AS code, COALESCE(e.name, 'غير مسجل') AS name, e.dept AS dept,
        to_char(p.punch_time, 'YYYY-MM-DD') AS d, to_char(p.punch_time, 'HH24:MI') AS tm
      FROM punches p LEFT JOIN employees e ON e.code = p.emp_code
      WHERE p.punch_time >= ${from}::date AND p.punch_time < ${to}::date + 1
        AND (${dept} = '' OR e.dept = ${dept}) AND (${code} = '' OR p.emp_code = ${code})
        AND (${scope} = 'all' OR (${scope} = 'known' AND e.code IS NOT NULL) OR (${scope} = 'unknown' AND e.code IS NULL))
      ORDER BY length(p.emp_code), p.emp_code, p.punch_time`);
  }
  res.json(await sql`
    SELECT p.emp_code AS code, COALESCE(e.name, 'غير مسجل') AS name, e.dept AS dept,
      to_char(p.punch_time::date, 'YYYY-MM-DD') AS d,
      to_char(min(p.punch_time), 'HH24:MI') AS t_in, to_char(max(p.punch_time), 'HH24:MI') AS t_out,
      count(*)::int AS n,
      (extract(epoch FROM max(p.punch_time) - min(p.punch_time)) / 3600)::float AS hours
    FROM punches p LEFT JOIN employees e ON e.code = p.emp_code
    WHERE p.punch_time >= ${from}::date AND p.punch_time < ${to}::date + 1
      AND (${dept} = '' OR e.dept = ${dept}) AND (${code} = '' OR p.emp_code = ${code})
      AND (${scope} = 'all' OR (${scope} = 'known' AND e.code IS NOT NULL) OR (${scope} = 'unknown' AND e.code IS NULL))
    GROUP BY p.emp_code, e.name, e.dept, p.punch_time::date
    ORDER BY length(p.emp_code), p.emp_code, p.punch_time::date`);
});

// أكواد في البصمات ومش في بيانات الموظفين
app.get('/api/unknown', async (req, res) => {
  res.json(await sql`
    SELECT p.emp_code AS code, count(*)::int AS n,
      to_char(min(p.punch_time), 'YYYY-MM-DD') AS first_at, to_char(max(p.punch_time), 'YYYY-MM-DD') AS last_at
    FROM punches p LEFT JOIN employees e ON e.code = p.emp_code
    WHERE e.code IS NULL GROUP BY p.emp_code ORDER BY length(p.emp_code), p.emp_code`);
});

// ---------- المستخدمين (للمدير فقط) ----------
app.get('/api/users', async (req, res) => {
  res.json(await sql`SELECT username, role, active FROM users ORDER BY created_at`);
});
app.post('/api/users', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase(), password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'viewer';
  if (!/^[a-z0-9_.-]{3,30}$/.test(username)) return bad(res, 'اسم المستخدم: من 3 إلى 30 حرف إنجليزي أو أرقام');
  if (password.length < 8) return bad(res, 'كلمة السر لازم 8 حروف على الأقل');
  const r = await sql`INSERT INTO users (username, pw, role) VALUES (${username}, ${hash(password)}, ${role}) ON CONFLICT DO NOTHING RETURNING username`;
  if (!r.length) return bad(res, 'اسم المستخدم موجود قبل كده');
  res.json({ success: true });
});
app.put('/api/users/:u', async (req, res) => {
  const u = req.params.u.toLowerCase(), b = req.body;
  const role = b.role === 'admin' || b.role === 'viewer' ? b.role : null;
  const active = typeof b.active === 'boolean' ? b.active : null;
  const pw = b.password != null ? String(b.password) : null;
  if (pw !== null && pw.length < 8) return bad(res, 'كلمة السر لازم 8 حروف على الأقل');
  if (u === req.user.username && (active === false || (role && role !== 'admin'))) return bad(res, 'ما تقدرش توقف حسابك أو تقلل صلاحيته');
  await sql`UPDATE users SET role = COALESCE(${role}, role), active = COALESCE(${active}, active), pw = COALESCE(${pw === null ? null : hash(pw)}, pw) WHERE username = ${u}`;
  res.json({ success: true });
});
app.delete('/api/users/:u', async (req, res) => {
  const u = req.params.u.toLowerCase();
  if (u === req.user.username) return bad(res, 'ما تقدرش تمسح حسابك');
  await sql`DELETE FROM users WHERE username = ${u}`;
  res.json({ success: true });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'حصل خطأ في السيرفر' });
});

const PORT = process.env.PORT || 3000;
init()
  .then(() => app.listen(PORT, '0.0.0.0', () => console.log(`✅ السيرفر شغال على المنفذ ${PORT}`)))
  .catch(e => { console.error('فشل الاتصال بقاعدة البيانات:', e.message); process.exit(1); });
