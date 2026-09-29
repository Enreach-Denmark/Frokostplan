const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const scrypt = promisify(crypto.scrypt);
const port = Number(process.env.PORT) || 3000;
const root = __dirname;
const dataDir = process.env.LUNCHLY_DATA_DIR ? path.resolve(process.env.LUNCHLY_DATA_DIR) : path.join(root, 'data');
const tlsDir = process.env.LUNCHLY_TLS_DIR ? path.resolve(process.env.LUNCHLY_TLS_DIR)
  : process.env.LUNCHLY_DATA_DIR ? path.join(dataDir, 'tls')
  : path.join(process.env.LOCALAPPDATA || dataDir, 'Lunchly', 'tls');
const pfxFile = path.join(tlsDir, 'server.pfx');
const pfxPasswordFile = path.join(tlsDir, 'passphrase.txt');
const secureMode = process.env.LUNCHLY_DISABLE_HTTPS !== '1' && fsSync.existsSync(pfxFile) && fsSync.existsSync(pfxPasswordFile);
const host = process.env.LUNCHLY_HOST || (secureMode ? '0.0.0.0' : '127.0.0.1');
const protocol = secureMode ? 'https' : 'http';
const planFile = path.join(dataDir, 'lunch-plan.json');
const accountFile = path.join(dataDir, 'accounts.sqlite');
fsSync.mkdirSync(dataDir, { recursive: true });
const accountDb = new DatabaseSync(accountFile);
accountDb.exec('CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL, employee_id TEXT)');
if (!accountDb.prepare('PRAGMA table_info(accounts)').all().some(column => column.name === 'recovery_hash')) accountDb.exec('ALTER TABLE accounts ADD COLUMN recovery_hash TEXT');
const sessions = new Map();
const failures = new Map();
const sessionLifetime = 12 * 60 * 60 * 1000;
const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8']
};

function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}
function json(res, status, value, headers) { send(res, status, JSON.stringify(value), 'application/json; charset=utf-8', headers); }
function fail(res, status, message) { return json(res, status, { error: message }); }
function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function validRecovery(value) { return typeof value === 'string' && value.trim().length >= 16 && value.length <= 256; }
function validPlan(data) {
  return data && typeof data === 'object' && Array.isArray(data.teams) &&
    Array.isArray(data.employees) && Array.isArray(data.slots) &&
    data.plans && typeof data.plans === 'object' && !Array.isArray(data.plans);
}
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function writeJson(file, data) {
  await fs.mkdir(dataDir, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(temporary, file);
}
function loadAccounts() {
  return accountDb.prepare('SELECT id, name, email, password_hash AS passwordHash, recovery_hash AS recoveryHash, role, employee_id AS employeeId FROM accounts').all();
}
function saveAccounts(accounts) {
  accountDb.exec('BEGIN IMMEDIATE');
  try {
    accountDb.exec('DELETE FROM accounts');
    const insert = accountDb.prepare('INSERT INTO accounts (id, name, email, password_hash, recovery_hash, role, employee_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    accounts.forEach(a => insert.run(a.id, a.name, a.email, a.passwordHash, a.recoveryHash || null, a.role, a.employeeId || null));
    accountDb.exec('COMMIT');
  } catch (error) { accountDb.exec('ROLLBACK'); throw error; }
}
const legacyAccounts = path.join(dataDir, 'accounts.json');
if (loadAccounts().length === 0 && fsSync.existsSync(legacyAccounts)) {
  const records = JSON.parse(fsSync.readFileSync(legacyAccounts, 'utf8'));
  if (Array.isArray(records)) saveAccounts(records);
}
async function readBody(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 2_000_000) throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}
async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = await scrypt(password, Buffer.from(salt, 'hex'), 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  return `scrypt:32768:8:3:${salt}:${hash.toString('hex')}`;
}
async function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, expected] = parts;
  const actual = await scrypt(password, Buffer.from(salt, 'hex'), 64, { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}
function cookie(req, name) {
  return (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`))?.slice(name.length + 1);
}
function sessionUser(req, accounts) {
  const token = cookie(req, 'lunchly_session');
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expires < Date.now()) { sessions.delete(token); return null; }
  return accounts.find(a => a.id === session.userId) || null;
}
function publicUser(account) {
  return { id: account.id, name: account.name, email: account.email, role: account.role, employeeId: account.employeeId || null };
}
function sessionCookie(token, maxAge) { return `lunchly_session=${token}; HttpOnly; SameSite=Strict; ${secureMode?'Secure; ':''}Path=/; Max-Age=${maxAge}`; }
function beginSession(res, account) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { userId: account.id, expires: Date.now() + sessionLifetime });
  res.setHeader('Set-Cookie', sessionCookie(token, sessionLifetime / 1000));
}
function authLimit(key) {
  const now = Date.now(); const entry = failures.get(key);
  if (!entry || entry.reset < now) { failures.set(key, { count: 0, reset: now + 15 * 60 * 1000 }); return false; }
  return entry.count >= 8;
}
function authFailed(key) { const entry = failures.get(key); if (entry) entry.count += 1; }
function safeOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  // When running behind a TLS reverse proxy, Host/protocol at the Node
  // process can differ from the public origin seen by the browser.
  const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const forwardedProto = String(req.headers['x-forwarded-proto'] || protocol).split(',')[0].trim();
  return origin === `${forwardedProto}://${forwardedHost}` || origin === `${protocol}://${req.headers.host}`;
}
function exposedState(plan, user, accounts = []) {
  return {
    ...plan,
    employees: plan.employees.map(e => ({ ...e, role: accounts.find(a => a.employeeId === e.id && a.role !== 'pending')?.role || e.role || 'employee' })),
    currentEmployeeId: user.employeeId,
    requests: user.role === 'admin' ? (plan.requests || []) : (plan.requests || []).filter(r => r.fromId === user.employeeId || r.toId === user.employeeId)
  };
}
function validDays(dates) {
  if (!Array.isArray(dates) || dates.length < 1 || dates.length > 5 || new Set(dates).size !== dates.length) return false;
  if (!dates.every(date => /^\d{4}-\d{2}-\d{2}$/.test(date) && [1,2,3,4,5].includes(new Date(`${date}T12:00:00`).getDay()))) return false;
  return dates.every(date => weekKey(date) === weekKey(dates[0]));
}
function weekKey(date) {
  const day = new Date(`${date}T12:00:00`);
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

let writeQueue = Promise.resolve();
function locked(work) {
  const result = writeQueue.then(work);
  writeQueue = result.catch(() => {});
  return result;
}

const listener = async (req, res) => {
  try {
    const pathname = new URL(req.url, `${protocol}://${host}:${port}`).pathname;
    if (req.method !== 'GET' && !safeOrigin(req)) return fail(res, 403, 'Invalid origin');
    if (req.method === 'GET' && files[pathname]) {
      const [filename, type] = files[pathname];
      return send(res, 200, await fs.readFile(path.join(root, filename)), type);
    }
    if (!pathname.startsWith('/api/')) return fail(res, 404, 'Not found');

    const accounts = loadAccounts();
    const user = sessionUser(req, accounts);
    if (pathname === '/api/session' && req.method === 'GET') return json(res, 200, { user: user ? publicUser(user) : null, firstUser: accounts.length === 0 });

    if (pathname === '/api/register' && req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      const recoveryPhrase = body.recoveryPhrase;
      if (name.length < 2 || name.length > 80 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 12 || password.length > 256 || !validRecovery(recoveryPhrase)) return fail(res, 400, 'Enter a name, valid email, password of at least 12 characters, and recovery phrase of at least 16 characters');
      if (password !== body.confirmPassword) return fail(res, 400, 'Passwords do not match');
      const key = `register:${req.socket.remoteAddress}`;
      if (authLimit(key)) return fail(res, 429, 'Too many attempts. Try again later.');
      const hash = await hashPassword(password);
      const recoveryHash = await hashPassword(recoveryPhrase.trim());
      return locked(async () => {
        const latest = loadAccounts();
        if (latest.some(a => a.email === email)) { authFailed(key); return fail(res, 409, 'Account already exists'); }
        const first = latest.length === 0;
        const account = { id: crypto.randomUUID(), name, email, passwordHash: hash, recoveryHash, role: first ? 'admin' : 'pending', employeeId: null };
        if (first) {
          const plan = await readJson(planFile, null);
          if (plan && validPlan(plan)) {
            const existing = plan.employees.find(e => e.email === email);
            if (existing) { account.employeeId = existing.id; existing.role = 'admin'; plan.revision = (plan.revision || 0) + 1; await writeJson(planFile, plan); }
            else {
              account.employeeId = crypto.randomUUID();
              plan.employees.push({ id: account.employeeId, name, email, role: 'admin' });
              plan.revision = (plan.revision || 0) + 1;
              await writeJson(planFile, plan);
            }
          } else {
            account.employeeId = crypto.randomUUID();
            await writeJson(planFile, {
              teams: [], employees: [{ id: account.employeeId, name, email, role: 'admin' }],
              slots: ['11:00', '11:30', '12:00', '12:30'].map((start, i) => ({ id: `slot${i}`, start, duration: 30 })),
              plans: {}, requests: [], currentEmployeeId: null, revision: 1
            });
          }
        }
        latest.push(account);
        saveAccounts(latest);
        beginSession(res, account);
        return json(res, 201, { user: publicUser(account) });
      });
    }
    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      const email = normalizeEmail(body.email), password = String(body.password || '');
      const key = `login:${req.socket.remoteAddress}:${email}`;
      if (authLimit(key)) return fail(res, 429, 'Too many attempts. Try again later.');
      const account = accounts.find(a => a.email === email);
      const valid = account && await verifyPassword(password, account.passwordHash);
      if (!valid) { authFailed(key); return fail(res, 401, 'Invalid email or password'); }
      failures.delete(key);
      beginSession(res, account);
      return json(res, 200, { user: publicUser(account) });
    }
    if (pathname === '/api/reset-password' && req.method === 'POST') {
      const body = await readBody(req);
      const email = normalizeEmail(body.email);
      const phrase = String(body.recoveryPhrase || '').trim();
      const password = String(body.password || '');
      if (password.length < 12 || password.length > 256) return fail(res, 400, 'Password must be 12 to 256 characters');
      const key = `reset:${req.socket.remoteAddress}:${email}`;
      if (authLimit(key)) return fail(res, 429, 'Too many attempts. Try again later.');
      const account = accounts.find(a => a.email === email);
      if (!account?.recoveryHash || !await verifyPassword(phrase, account.recoveryHash)) { authFailed(key); return fail(res, 401, 'Invalid email or recovery phrase'); }
      const hash = await hashPassword(password);
      return locked(async () => {
        const latest = loadAccounts();
        const target = latest.find(a => a.id === account.id);
        if (!target || target.recoveryHash !== account.recoveryHash) return fail(res, 409, 'Recovery phrase changed. Try again.');
        target.passwordHash = hash;
        saveAccounts(latest);
        for (const [token, session] of sessions) if (session.userId === target.id) sessions.delete(token);
        failures.delete(key);
        return json(res, 200, { ok: true });
      });
    }
    if (pathname === '/api/logout' && req.method === 'POST') {
      sessions.delete(cookie(req, 'lunchly_session'));
      return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    }
    if (!user) return fail(res, 401, 'Sign in required');
    if (pathname === '/api/recovery-phrase' && req.method === 'POST') {
      const body = await readBody(req);
      if (!validRecovery(body.recoveryPhrase)) return fail(res, 400, 'Recovery phrase must be 16 to 256 characters');
      const hash = await hashPassword(body.recoveryPhrase.trim());
      return locked(async () => {
        const latest = loadAccounts();
        const target = latest.find(a => a.id === user.id);
        if (!target) return fail(res, 401, 'Sign in required');
        target.recoveryHash = hash;
        saveAccounts(latest);
        return json(res, 200, { ok: true });
      });
    }
    if (user.role === 'pending') return fail(res, 403, 'Waiting for administrator approval');

    if (pathname === '/api/state' && req.method === 'GET') {
      const plan = await readJson(planFile, null);
      return json(res, 200, validPlan(plan) ? exposedState(plan, user, accounts) : null);
    }
    if (pathname === '/api/state' && req.method === 'PUT') {
      if (user.role !== 'admin') return fail(res, 403, 'Administrator access required');
      const body = await readBody(req);
      if (!validPlan(body)) return fail(res, 400, 'Invalid plan data');
      return locked(async () => {
        const current = await readJson(planFile, null);
        if (current && Number(body.revision || 0) !== Number(current.revision || 0)) return fail(res, 409, 'Plan changed. Refresh and try again.');
        const next = {
          teams: [], employees: body.employees, slots: body.slots, plans: body.plans,
          requests: current?.requests || [], lunchNow: current?.lunchNow || {}, currentEmployeeId: null,
          revision: Number(current?.revision || 0) + 1
        };
        if (next.slots.length !== 4 || !next.employees.every(e => typeof e.id === 'string' && typeof e.name === 'string' && ['employee','admin'].includes(e.role || 'employee') && (e.excludedFromLunch === undefined || typeof e.excludedFromLunch === 'boolean'))) return fail(res, 400, 'Invalid plan data');
        const excluded = new Set(next.employees.filter(e => e.excludedFromLunch).map(e => e.id));
        const today = new Date();
        const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        for (const week of Object.values(next.plans)) for (const [date, day] of Object.entries(week)) if (date >= todayKey) for (const id of excluded) delete day[id];
        for (const week of Object.values(next.lunchNow)) for (const [date, day] of Object.entries(week)) if (date >= todayKey) for (const id of excluded) delete day[id];
        const latestAccounts = loadAccounts();
        if (latestAccounts.some(a => a.employeeId && !next.employees.some(e => e.id === a.employeeId))) return fail(res, 409, 'An account is linked to an employee you removed');
        latestAccounts.forEach(a => { if (a.employeeId && a.role !== 'pending') a.role = next.employees.find(e => e.id === a.employeeId)?.role || 'employee'; });
        if (!latestAccounts.some(a => a.role === 'admin')) return fail(res, 409, 'At least one administrator is required');
        await writeJson(planFile, next);
        saveAccounts(latestAccounts);
        return json(res, 200, exposedState(next, user, latestAccounts));
      });
    }
    if (pathname === '/api/users' && req.method === 'GET') {
      if (user.role !== 'admin') return fail(res, 403, 'Administrator access required');
      return json(res, 200, accounts.map(publicUser));
    }
    const approve = pathname.match(/^\/api\/users\/([^/]+)\/approve$/);
    if (approve && req.method === 'POST') {
      if (user.role !== 'admin') return fail(res, 403, 'Administrator access required');
      const body = await readBody(req);
      return locked(async () => {
        const latest = loadAccounts();
        const target = latest.find(a => a.id === approve[1]);
        const plan = await readJson(planFile, null);
        if (!target || !validPlan(plan)) return fail(res, 404, 'Account or plan not found');
        if (target.role !== 'pending') return fail(res, 409, 'Account is already approved');
        let linkedEmployee;
        if (body.employeeId) {
          linkedEmployee = plan.employees.find(e => e.id === body.employeeId);
          if (!linkedEmployee) return fail(res, 400, 'Employee not found in roster');
          if (latest.some(a => a.employeeId === body.employeeId)) return fail(res, 409, 'Employee already linked to an account');
        } else {
          linkedEmployee = { id: crypto.randomUUID(), name: target.name, email: target.email, role: 'employee' };
          plan.employees.push(linkedEmployee);
          plan.revision = (plan.revision || 0) + 1;
          await writeJson(planFile, plan);
        }
        target.role = linkedEmployee.role || 'employee';
        target.employeeId = linkedEmployee.id;
        saveAccounts(latest);
        return json(res, 200, { user: publicUser(target) });
      });
    }
    if (pathname === '/api/lunch-now' && req.method === 'POST') {
      if (!user.employeeId) return fail(res, 403, 'No employee linked to account');
      return locked(async () => {
        const plan = await readJson(planFile, null);
        if (!validPlan(plan)) return fail(res, 404, 'Plan not found');
        if (plan.employees.find(e => e.id === user.employeeId)?.excludedFromLunch) return fail(res, 403, 'You are excluded from the lunch plan');
        const now = new Date();
        const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const week = weekKey(date);
        const slotId = plan.plans[week]?.[date]?.[user.employeeId];
        const slot = plan.slots.find(s => s.id === slotId);
        if (!slot) return fail(res, 409, 'You do not have a lunch time today');
        const [hours, minutes] = slot.start.split(':').map(Number);
        const startMinutes = hours * 60 + minutes;
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        if (currentMinutes < startMinutes || currentMinutes >= startMinutes + Number(slot.duration)) return fail(res, 409, 'Lunch now is available only during your assigned lunch time');
        plan.lunchNow ||= {};
        plan.lunchNow[week] ||= {};
        plan.lunchNow[week][date] ||= {};
        if (plan.lunchNow[week][date][user.employeeId]?.slotId === slotId) return fail(res, 409, 'Lunch now has already been used today');
        const start = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const duration = 30;
        const endMinutes = currentMinutes + duration;
        const end = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;
        const window = { slotId, start, end };
        plan.lunchNow[week][date][user.employeeId] = window;
        plan.revision = (plan.revision || 0) + 1;
        await writeJson(planFile, plan);
        return json(res, 200, { window, revision: plan.revision });
      });
    }
    if (pathname === '/api/swaps' && req.method === 'POST') {
      if (!user.employeeId) return fail(res, 403, 'No employee linked to account');
      const body = await readBody(req);
      if (!validDays(body.dates) || typeof body.toId !== 'string' || body.toId === user.employeeId) return fail(res, 400, 'Choose a coworker and valid days in one week');
      return locked(async () => {
        const plan = await readJson(planFile, null);
        if (!validPlan(plan) || !plan.employees.some(e => e.id === body.toId && !e.excludedFromLunch)) return fail(res, 400, 'Coworker not found');
        if (plan.employees.find(e => e.id === user.employeeId)?.excludedFromLunch) return fail(res, 403, 'You are excluded from the lunch plan');
        if (body.dates.some(date => !plan.plans[weekKey(date)]?.[date]?.[user.employeeId] || !plan.plans[weekKey(date)]?.[date]?.[body.toId])) return fail(res, 400, 'Both employees need a lunch time on each day');
        const request = { id: crypto.randomUUID(), fromId: user.employeeId, toId: body.toId, dates: body.dates, status: 'pending', createdAt: new Date().toISOString(),
          fromSlots: body.dates.map(date => plan.plans[weekKey(date)][date][user.employeeId]),
          toSlots: body.dates.map(date => plan.plans[weekKey(date)][date][body.toId]) };
        plan.requests.push(request);
        plan.revision = (plan.revision || 0) + 1;
        await writeJson(planFile, plan);
        return json(res, 201, { request, revision: plan.revision });
      });
    }
    const swapAction = pathname.match(/^\/api\/swaps\/([^/]+)\/(accept|decline|cancel)$/);
    if (swapAction && req.method === 'POST') {
      return locked(async () => {
        const plan = await readJson(planFile, null);
        const request = plan?.requests?.find(r => r.id === swapAction[1]);
        if (!request) return fail(res, 404, 'Request not found');
        if (request.status !== 'pending') return fail(res, 409, 'Request already handled');
        const action = swapAction[2];
        if (action === 'cancel' ? request.fromId !== user.employeeId : request.toId !== user.employeeId) return fail(res, 403, 'This request is not yours');
        if (action === 'accept') {
          if (plan.employees.some(e => (e.id === request.fromId || e.id === request.toId) && e.excludedFromLunch)) return fail(res, 409, 'An employee is excluded from the lunch plan');
          if (request.dates.some(date => !plan.plans[weekKey(date)]?.[date]?.[request.fromId] || !plan.plans[weekKey(date)]?.[date]?.[request.toId])) return fail(res, 409, 'An assignment changed. Request a new swap.');
          if (request.fromSlots && request.dates.some((date, i) => plan.plans[weekKey(date)][date][request.fromId] !== request.fromSlots[i] || plan.plans[weekKey(date)][date][request.toId] !== request.toSlots[i])) return fail(res, 409, 'An assignment changed. Request a new swap.');
          request.dates.forEach(date => {
            const day = plan.plans[weekKey(date)][date];
            [day[request.fromId], day[request.toId]] = [day[request.toId], day[request.fromId]];
          });
          request.status = 'accepted';
        } else request.status = 'declined';
        plan.revision = (plan.revision || 0) + 1;
        await writeJson(planFile, plan);
        return json(res, 200, { request, revision: plan.revision });
      });
    }
    return fail(res, 404, 'Not found');
  } catch (error) {
    console.error(error);
    return fail(res, error.status || 500, error.status ? error.message : 'Server error');
  }
};

const server = secureMode
  ? https.createServer({ pfx: fsSync.readFileSync(pfxFile), passphrase: fsSync.readFileSync(pfxPasswordFile, 'utf8').trim() }, listener)
  : http.createServer(listener);
server.listen(port, host, () => console.log(`Lunchly is running at ${protocol}://${host === '0.0.0.0' ? '<this-computer-LAN-IP>' : host}:${port}`));
