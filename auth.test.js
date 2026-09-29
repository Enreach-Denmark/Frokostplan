const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

test('local accounts enforce roles and swap ownership', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lunchly-auth-'));
  const port = 30000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: __dirname, env: { ...process.env, PORT: String(port), LUNCHLY_DATA_DIR: dataDir }, stdio: 'ignore'
  });
  async function call(route, method = 'GET', body, cookie) {
    const response = await fetch(base + route, {
      method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { await call('/api/session'); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.equal(ready, true, 'server started');
    const password = 'correct horse battery staple';
    const recoveryPhrase = 'violet river morning lantern';
    assert.equal((await call('/api/register', 'POST', { name: 'Admin', email: 'admin@example.com', password, confirmPassword: 'a different long password', recoveryPhrase })).status, 400);
    const admin = await call('/api/register', 'POST', { name: 'Admin', email: 'admin@example.com', password, confirmPassword: password, recoveryPhrase });
    assert.equal(admin.status, 201);
    assert.equal(admin.data.user.role, 'admin');
    let adminCookie = admin.cookie;
    assert.equal((await call('/api/lunch-now', 'POST', {}, adminCookie)).status, 409);
    const accountDb = new DatabaseSync(path.join(dataDir, 'accounts.sqlite'));
    const storedAccount = accountDb.prepare('SELECT password_hash, recovery_hash FROM accounts WHERE email = ?').get('admin@example.com');
    const stored = storedAccount.password_hash;
    accountDb.close();
    assert.doesNotMatch(stored, /correct horse battery staple/);
    assert.match(stored, /scrypt:32768/);
    assert.doesNotMatch(storedAccount.recovery_hash, /violet river morning lantern/);
    assert.equal((await call('/api/reset-password', 'POST', { email: 'admin@example.com', recoveryPhrase: 'wrong phrase', password: 'brand new long password' })).status, 401);
    assert.equal((await call('/api/reset-password', 'POST', { email: 'admin@example.com', recoveryPhrase, password: 'brand new long password' })).status, 200);
    assert.equal((await call('/api/login', 'POST', { email: 'admin@example.com', password })).status, 401);
    assert.equal((await call('/api/login', 'POST', { email: 'admin@example.com', password: 'brand new long password' })).status, 200);
    assert.equal((await call('/api/session', 'GET', null, adminCookie)).data.user, null);
    const renewedAdmin = await call('/api/login', 'POST', { email: 'admin@example.com', password: 'brand new long password' });
    adminCookie = renewedAdmin.cookie;

    const bob = await call('/api/register', 'POST', { name: 'Bob', email: 'bob@example.com', password, confirmPassword: password, recoveryPhrase });
    const carol = await call('/api/register', 'POST', { name: 'Carol', email: 'carol@example.com', password, confirmPassword: password, recoveryPhrase });
    assert.equal((await call('/api/recovery-phrase', 'POST', { recoveryPhrase: 'different private recovery phrase' }, bob.cookie)).status, 200);
    assert.equal((await call('/api/reset-password', 'POST', { email: 'bob@example.com', recoveryPhrase, password: 'bob updated password' })).status, 401);
    assert.equal((await call('/api/reset-password', 'POST', { email: 'bob@example.com', recoveryPhrase: 'different private recovery phrase', password: 'bob updated password' })).status, 200);
    bob.cookie = (await call('/api/login', 'POST', { email: 'bob@example.com', password: 'bob updated password' })).cookie;
    assert.equal(bob.data.user.role, 'pending');
    assert.equal((await call('/api/state', 'GET', null, bob.cookie)).status, 403);
    assert.equal((await call('/api/state', 'PUT', {}, bob.cookie)).status, 403);

    const state = (await call('/api/state', 'GET', null, adminCookie)).data;
    state.employees.push({ id: 'bob', name: 'Bob' }, { id: 'carol', name: 'Carol' });
    const monday = new Date(); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const dates = Array.from({ length: 5 }, (_, i) => { const d = new Date(monday); d.setDate(d.getDate() + i); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; });
    const week = dates[0]; state.plans[week] = {};
    dates.forEach(date => { state.plans[week][date] = { bob: 'slot0', carol: 'slot1', [admin.data.user.employeeId]: 'slot2' }; });
    assert.equal((await call('/api/state', 'PUT', state, adminCookie)).status, 200);
    const bobApproval = await call(`/api/users/${bob.data.user.id}/approve`, 'POST', { role: 'admin', employeeId: 'bob' }, adminCookie);
    assert.equal(bobApproval.status, 200);
    assert.equal(bobApproval.data.user.role, 'employee');
    assert.equal((await call(`/api/users/${carol.data.user.id}/approve`, 'POST', { role: 'employee', employeeId: 'carol' }, adminCookie)).status, 200);
    assert.equal((await call(`/api/users/${carol.data.user.id}/approve`, 'POST', { employeeId: 'bob' }, adminCookie)).status, 409);
    const dave = await call('/api/register', 'POST', { name: 'Dave', email: 'dave@example.com', password, confirmPassword: password, recoveryPhrase });
    assert.equal(dave.data.user.role, 'pending');
    assert.equal((await call('/api/state', 'GET', null, dave.cookie)).status, 403);
    assert.equal((await call('/api/users', 'GET', null, dave.cookie)).status, 403);
    const daveApproval = await call(`/api/users/${dave.data.user.id}/approve`, 'POST', {}, adminCookie);
    assert.equal(daveApproval.status, 200);
    assert.equal(daveApproval.data.user.role, 'employee');
    assert.equal((await call('/api/state', 'GET', null, dave.cookie)).data.employees.some(e => e.id === daveApproval.data.user.employeeId), true);
    assert.equal((await call('/api/state', 'PUT', state, bob.cookie)).status, 403);

    const request = await call('/api/swaps', 'POST', { fromId: 'carol', toId: 'carol', dates: [dates[0]] }, bob.cookie);
    assert.equal(request.status, 201);
    assert.equal(request.data.request.fromId, 'bob');
    const id = request.data.request.id;
    assert.equal((await call(`/api/swaps/${id}/accept`, 'POST', {}, bob.cookie)).status, 403);
    assert.equal((await call(`/api/swaps/${id}/accept`, 'POST', {}, adminCookie)).status, 403);
    assert.equal((await call(`/api/swaps/${id}/accept`, 'POST', {}, carol.cookie)).status, 200);
    const after = (await call('/api/state', 'GET', null, bob.cookie)).data;
    assert.equal(after.plans[week][dates[0]].bob, 'slot1');
    assert.equal(after.plans[week][dates[1]].bob, 'slot0');
    const updated = (await call('/api/state', 'GET', null, adminCookie)).data;
    updated.employees.find(e => e.id === 'carol').role = 'admin';
    assert.equal((await call('/api/state', 'PUT', updated, adminCookie)).status, 200);
    assert.equal((await call('/api/session', 'GET', null, carol.cookie)).data.user.role, 'admin');
    assert.equal((await call('/api/state', 'PUT', updated, bob.cookie)).status, 403);
    const lastAdmin = (await call('/api/state', 'GET', null, adminCookie)).data;
    lastAdmin.employees.find(e => e.id === admin.data.user.employeeId).role = 'employee';
    lastAdmin.employees.find(e => e.id === 'carol').role = 'employee';
    assert.equal((await call('/api/state', 'PUT', lastAdmin, adminCookie)).status, 409);
    const exclusion = (await call('/api/state', 'GET', null, adminCookie)).data;
    const future = new Date(); future.setDate(future.getDate() + 14);
    const futureDate = `${future.getFullYear()}-${String(future.getMonth()+1).padStart(2,'0')}-${String(future.getDate()).padStart(2,'0')}`;
    const futureMonday = new Date(future); futureMonday.setDate(future.getDate() - ((future.getDay()+6)%7));
    const futureWeek = `${futureMonday.getFullYear()}-${String(futureMonday.getMonth()+1).padStart(2,'0')}-${String(futureMonday.getDate()).padStart(2,'0')}`;
    exclusion.plans[futureWeek] = { [futureDate]: { bob: 'slot0', carol: 'slot1' } };
    exclusion.employees.find(e => e.id === 'bob').excludedFromLunch = true;
    assert.equal((await call('/api/state', 'PUT', exclusion, adminCookie)).status, 200);
    const afterExclusion = (await call('/api/state', 'GET', null, adminCookie)).data;
    assert.equal(afterExclusion.employees.find(e => e.id === 'bob').excludedFromLunch, true);
    assert.equal(afterExclusion.plans[futureWeek][futureDate].bob, undefined);
    assert.equal(afterExclusion.plans[futureWeek][futureDate].carol, 'slot1');
    afterExclusion.employees.find(e => e.id === 'bob').excludedFromLunch = false;
    assert.equal((await call('/api/state', 'PUT', afterExclusion, adminCookie)).status, 200);
    assert.equal((await call('/api/state', 'GET', null, adminCookie)).data.plans[futureWeek][futureDate].bob, undefined);
    const lunchPlan = (await call('/api/state', 'GET', null, adminCookie)).data;
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const lunchMonday = new Date(now); lunchMonday.setDate(now.getDate() - ((now.getDay()+6)%7));
    const todayWeek = `${lunchMonday.getFullYear()}-${String(lunchMonday.getMonth()+1).padStart(2,'0')}-${String(lunchMonday.getDate()).padStart(2,'0')}`;
    lunchPlan.slots[0].start = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    lunchPlan.plans[todayWeek] ||= {};
    lunchPlan.plans[todayWeek][today] ||= {};
    lunchPlan.plans[todayWeek][today][admin.data.user.employeeId] = 'slot0';
    assert.equal((await call('/api/state', 'PUT', lunchPlan, adminCookie)).status, 200);
    const lunchNow = await call('/api/lunch-now', 'POST', {}, adminCookie);
    assert.equal(lunchNow.status, 200);
    assert.equal((await call('/api/lunch-now', 'POST', {}, adminCookie)).status, 409);
    const annotated = (await call('/api/state', 'GET', null, adminCookie)).data;
    assert.equal(annotated.plans[todayWeek][today][admin.data.user.employeeId], 'slot0');
    assert.equal(annotated.lunchNow[todayWeek][today][admin.data.user.employeeId].slotId, 'slot0');
  } finally {
    server.kill();
    if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
