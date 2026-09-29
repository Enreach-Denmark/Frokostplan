const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
const FIXED_SLOTS = ['11:00','11:30','12:00','12:30'];
const COLORS = [
  { bg:'#e8f0e9', fg:'#468765' }, { bg:'#fff1e7', fg:'#d88d58' },
  { bg:'#e9edf9', fg:'#738bc1' }, { bg:'#f6eaf0', fg:'#b77c9d' },
  { bg:'#e9f3f5', fg:'#5b9da7' }, { bg:'#f4efdf', fg:'#aa9554' }
];

function localDate(value) { const d = new Date(value); return new Date(d.getFullYear(),d.getMonth(),d.getDate()); }
function iso(date) { const d=localDate(date); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function fromIso(value) { const [y,m,d]=value.split('-').map(Number); return new Date(y,m-1,d); }
function addDays(date,n) { const d=localDate(date); d.setDate(d.getDate()+n); return d; }
function weekStart(date) { const d=localDate(date); return addDays(d,-((d.getDay()+6)%7)); }
function weekDates(start) { return DAYS.map((_,i)=>iso(addDays(start,i))); }
function fmt(date,options) { return new Intl.DateTimeFormat('en-GB',options).format(date); }
function shortDate(value) { return fmt(fromIso(value),{day:'numeric',month:'short'}); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function uid() { return Math.random().toString(36).slice(2,10); }
function initials(name) { return name.trim().split(/\s+/).slice(0,2).map(x=>x[0]?.toUpperCase()).join(''); }

function initialData() {
  const names=['Alex Chen','Sophie Larsen','Oliver Hansen','Emma Nielsen','Noah Jensen','Mia Andersen','Lucas Petersen','Freja Madsen','William Sørensen','Clara Rasmussen','Elias Holm','Alma Kristensen'];
  const employees=names.map((name,i)=>({id:'e'+(i+1),name}));
  const slots=FIXED_SLOTS.map((start,i)=>({id:'slot'+i,start,duration:30}));
  const plans={}; const thisWeek=iso(weekStart(new Date()));
  plans[thisWeek]={};
  weekDates(fromIso(thisWeek)).forEach(date=>{
    plans[thisWeek][date]={};
    employees.forEach((employee,i)=>{ plans[thisWeek][date][employee.id]=slots[i%4].id; });
  });
  return {teams:[],employees,slots,plans,requests:[],currentEmployeeId:'e1'};
}

let db=initialData();
let authUser=null;
let firstUser=false;
let adminUsers=[];
let authMode='login';
function migrateTimeSlots() {
  let changed=false;
  const previousSlots=db.slots;
  const nextSlots=FIXED_SLOTS.map((start,i)=>({id:'slot'+i,start,duration:30}));
  const idsMatch=previousSlots.length===4&&previousSlots.every((s,i)=>s.id===nextSlots[i].id&&s.start===nextSlots[i].start&&Number(s.duration)===30);
  for(const week of Object.values(db.plans)) for(const day of Object.values(week)) for(const [eid,value] of Object.entries(day)) {
    const oldId=typeof value==='string'?value:value?.slotId;
    if(!oldId) { delete day[eid]; changed=true; continue; }
    const oldStart=previousSlots.find(s=>s.id===oldId)?.start;
    const oldMinutes=oldStart?Number(oldStart.slice(0,2))*60+Number(oldStart.slice(3,5)):660;
    const nextIndex=FIXED_SLOTS.reduce((best,start,i)=>{
      const minutes=Number(start.slice(0,2))*60+Number(start.slice(3,5));
      const bestStart=FIXED_SLOTS[best],bestMinutes=Number(bestStart.slice(0,2))*60+Number(bestStart.slice(3,5));
      return Math.abs(minutes-oldMinutes)<Math.abs(bestMinutes-oldMinutes)?i:best;
    },0);
    const nextId=nextSlots[nextIndex].id;
    if(value!==nextId) { day[eid]=nextId; changed=true; }
  }
  if(!idsMatch) { db.slots=nextSlots; changed=true; }
  if(db.teams.length) { db.teams=[]; changed=true; }
  return changed;
}
let view='overview';
let selectedWeek=iso(weekStart(new Date()));
let selectedDay=iso(new Date().getDay()>=1&&new Date().getDay()<=5?new Date():weekStart(new Date()));
let requestTab='all';
let modal=null;
let saveQueue=Promise.resolve();
function save() {
  if(authUser?.role!=='admin') return;
  saveQueue=saveQueue.then(async()=>{
    const result=await api('/api/state',{method:'PUT',body:JSON.stringify(db)});
    db.revision=result.revision;
    authUser=(await api('/api/session')).user;
    if(authUser?.role==='admin') adminUsers=await api('/api/users');
    else view='overview';
    render();
  }).catch(error=>{ console.error(error); toast(error.message||'Could not save the plan.'); if(error.status===409) loadState(); });
}
async function api(url,options={}) {
  const response=await fetch(url,{headers:{'Content-Type':'application/json'},...options});
  const body=await response.text();
  let result;
  try { result=JSON.parse(body); }
  catch {
    const message=response.status===404?'The running server does not support this action. Restart node server.js.':`Server returned ${response.status}: ${body.slice(0,120)||'unexpected response'}`;
    const error=new Error(message); error.status=response.status; throw error;
  }
  if(!response.ok) {
    const message=response.status===404&&result.error==='Not found'&&url==='/api/lunch-now'
      ? 'Lunch now needs the updated server. Restart node server.js and try again.'
      : result.error||'Request failed';
    const error=new Error(message); error.status=response.status; throw error;
  }
  return result;
}
async function loadState() {
  const state=await api('/api/state');
  if(state) db=state;
  db.currentEmployeeId=authUser?.employeeId||null;
  if(authUser?.role==='admin') adminUsers=await api('/api/users');
  render();
}
function employee(id) { return db.employees.find(e=>e.id===id); }
function slot(id) { return db.slots.find(s=>s.id===id); }
function color(index) { return COLORS[index%COLORS.length]; }
function assignment(date,employeeId) {
  if(employee(employeeId)?.excludedFromLunch) return null;
  return db.plans[iso(weekStart(fromIso(date)))]?.[date]?.[employeeId] || null;
}
function lunchWindow(date,employeeId) {
  const window=db.lunchNow?.[iso(weekStart(fromIso(date)))]?.[date]?.[employeeId];
  return window?.slotId===assignment(date,employeeId)?window:null;
}
function lunchNowAvailable(now,slotId,used) {
  const planned=slot(slotId);
  if(!planned||used) return false;
  const [hours,minutes]=planned.start.split(':').map(Number);
  const current=now.getHours()*60+now.getMinutes();
  const start=hours*60+minutes;
  return current>=start&&current<start+Number(planned.duration);
}
function timeRange(slotId) { const s=slot(slotId); if(!s) return 'Not assigned'; const [h,m]=s.start.split(':').map(Number); const end=h*60+m+Number(s.duration); return `${s.start} – ${String(Math.floor(end/60)).padStart(2,'0')}:${String(end%60).padStart(2,'0')}`; }
function avatar(person,size='') { const c=color(Math.max(0,db.employees.findIndex(e=>e.id===person?.id)%COLORS.length)); return `<span class="mini-avatar ${size}" style="background:${c.bg};color:${c.fg}">${escapeHtml(initials(person?.name||'?'))}</span>`; }
function currentEmployee() { return employee(authUser?.employeeId); }
function pendingForMe() { return db.requests.filter(r=>r.toId===db.currentEmployeeId && r.status==='pending'); }
function heading(kicker,title,description,action='') { return `<div class="page-head"><div><div class="eyebrow">${kicker}</div><h1>${title}</h1><p>${description}</p></div>${action}</div>`; }
function weekLabel(start) { const end=addDays(fromIso(start),4); return `${fmt(fromIso(start),{day:'numeric',month:'short'})} – ${fmt(end,{day:'numeric',month:'short',year:'numeric'})}`; }

function renderAuth() {
  document.body.classList.add('auth-screen');
  document.getElementById('breadcrumb-current').textContent='Sign in';
  if(authUser?.role==='pending') {
    document.getElementById('content').innerHTML=`<div class="auth-card"><div class="eyebrow">ACCOUNT CREATED</div><h1>Waiting for approval</h1><p>Your account is registered. An administrator needs to link it to your employee record before you can use the lunch planner.</p><strong>${escapeHtml(authUser.email)}</strong><div class="auth-actions"><button class="button" data-action="refresh-session">Check again</button><button class="button soft" data-action="logout">Sign out</button></div></div>`;
    return;
  }
  const register=authMode==='register'||firstUser;
  if(authMode==='reset' && !firstUser) {
    document.getElementById('content').innerHTML=`<div class="auth-card"><div class="eyebrow">ACCOUNT RECOVERY</div><h1>Reset your password</h1><p>Enter the private recovery phrase you saved for this account.</p><form id="reset-form"><div class="field"><label>Email</label><input name="email" type="email" autocomplete="username" required></div><div class="field"><label>Recovery phrase</label><input name="recoveryPhrase" type="password" autocomplete="off" required></div><div class="field"><label>New password</label><input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="256" required></div><button class="button primary auth-submit" type="submit">Reset password</button></form><button class="text-link auth-toggle" data-action="show-login">Back to sign in</button></div>`;
    return;
  }
  document.getElementById('content').innerHTML=`<div class="auth-card"><div class="eyebrow">LUNCHLY ACCOUNT</div><h1>${register?'Create your account':'Welcome back'}</h1><p>${register?(firstUser?'The first account becomes the administrator.':'Register with your own details. An administrator will approve your account.'): 'Sign in to see your lunch plan and swap requests.'}</p><form id="auth-form"><input type="hidden" name="mode" value="${register?'register':'login'}">${register?'<div class="field"><label>Your name</label><input name="name" autocomplete="name" required maxlength="80"></div>':''}<div class="field"><label>Email</label><input name="email" type="email" autocomplete="username" required></div><div class="field"><label>Password</label><input name="password" type="password" autocomplete="${register?'new-password':'current-password'}" minlength="${register?'12':'1'}" required></div>${register?'<div class="field"><label>Confirm password</label><input name="confirmPassword" type="password" autocomplete="new-password" minlength="12" required></div><div class="field"><label>Private recovery phrase</label><input name="recoveryPhrase" type="password" autocomplete="off" minlength="16" maxlength="256" required><small class="hint">Use 16 or more characters that only you know. Save it somewhere safe; you will need it if you forget your password.</small></div>':''}<button class="button primary auth-submit" type="submit">${register?'Create account':'Sign in'}</button></form>${firstUser?'':`<button class="text-link auth-toggle" data-action="toggle-auth">${register?'Already have an account? Sign in':'Need an account? Register'}</button>${register?'':`<button class="text-link auth-toggle" data-action="show-reset">Forgot password?</button>`}`}</div>`;
}

function render() {
  if(!authUser || authUser.role==='pending') { renderAuth(); return; }
  document.body.classList.remove('auth-screen');
  document.querySelector('[data-view="admin"]').classList.toggle('hidden',authUser.role!=='admin');
  if(view==='admin'&&authUser.role!=='admin') view='overview';
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  document.getElementById('breadcrumb-current').textContent=({overview:'Overview',schedule:'Weekly plan',requests:'Swap requests',admin:'Admin settings'})[view];
  document.getElementById('today-label').textContent=fmt(new Date(),{weekday:'long',day:'numeric',month:'long'});
  const me=currentEmployee(); document.getElementById('side-name').textContent=authUser.name;
  document.getElementById('side-avatar').textContent=initials(authUser.name);
  document.getElementById('side-role').textContent=authUser.role==='admin'?'Administrator':'Employee';
  const count=pendingForMe().length; const countEl=document.getElementById('nav-count');
  countEl.textContent=count; countEl.classList.toggle('hidden',!count);
  document.getElementById('notification-dot').classList.toggle('hidden',!count);
  document.getElementById('content').innerHTML=({overview:renderOverview,schedule:renderSchedule,requests:renderRequests,admin:renderAdmin})[view]();
  if(view==='admin') {
    document.querySelectorAll('.account-employee').forEach(select=>{const button=document.createElement('button');button.className='button danger';button.dataset.action='reject-user';button.dataset.id=select.dataset.user;button.textContent='Reject';select.parentElement.append(button);});
    document.querySelectorAll('.account-row').forEach(row=>{const select=row.querySelector('[data-user]');const text=row.querySelector('small')?.textContent||'';const account=select?adminUsers.find(u=>u.id===select.dataset.user):adminUsers.find(u=>text.includes(u.email));if(account&&account.role!=='pending'&&account.id!==authUser.id){const button=document.createElement('button');button.className='button danger';button.dataset.action='revoke-user';button.dataset.id=account.id;button.textContent='Revoke access';row.append(button);}});
  }
  document.getElementById('modal-root').innerHTML=modal ? renderModal() : '';
}

function renderOverview() {
  const me=currentEmployee(); const now=new Date(); const today=iso(now); const todaySlot=assignment(today,me?.id);
  const window=lunchWindow(today,me?.id);
  const canLunchNow=lunchNowAvailable(now,todaySlot,window);
  const dates=weekDates(weekStart(new Date()));
  const scheduled=dates.filter(d=>assignment(d,me?.id)).length;
  const pending=db.requests.filter(r=>(r.fromId===me?.id||r.toId===me?.id)&&r.status==='pending').length;
  return `${heading('YOUR LUNCH, SIMPLIFIED',`Good ${new Date().getHours()<12?'morning':new Date().getHours()<17?'afternoon':'evening'}, ${escapeHtml(me?.name?.split(' ')[0]||'there')} 👋`,'Here’s what’s happening with lunch this week.',`<button class="button primary" data-action="open-swap">⇄ &nbsp; Request a swap</button>`)}
    <section class="hero"><div class="hero-copy"><div class="hero-kicker">✳ &nbsp; TODAY’S LUNCH</div><h2>${todaySlot?'Time to take a break.':'No lunch planned today.'}</h2><p>${todaySlot?`Your scheduled lunch time is ${escapeHtml(timeRange(todaySlot))}.`:'Check your weekly plan for upcoming lunches.'}${window?` Away ${escapeHtml(window.start)} – ${escapeHtml(window.end)} is shown beside your name in the weekly view.`:''}</p>${canLunchNow?'<button class="button lunch-now-button" data-action="lunch-now">Lunch now</button>':''}</div><div class="hero-time"><small>${todaySlot?'Scheduled lunch':'Today'}</small><strong>${todaySlot?timeRange(todaySlot):'—'}</strong><span>${window?`Away ${escapeHtml(window.start)} – ${escapeHtml(window.end)}`:todaySlot?'● On the schedule':'No assignment'}</span></div></section>
    <div class="section-grid"><div class="card card-pad"><div class="card-head"><h2>Your week at a glance</h2><button class="text-link" data-view="schedule">View full plan →</button></div><div class="week-strip">${dates.map((date,i)=>{const a=assignment(date,me?.id);return `<div class="day-tile ${date===today?'today':''}"><span class="day-name">${DAYS[i].slice(0,3)}</span><strong>${fromIso(date).getDate()}</strong><small>${a?'Lunch':'No plan'}</small><span class="time">${a?slot(a)?.start||'—':'—'}</span></div>`}).join('')}</div></div>
    <div class="card card-pad"><div class="card-head"><h2>At a glance</h2></div><div class="stat-list"><div class="stat-row"><span class="stat-icon">◷</span><div><strong>Scheduled lunches</strong><small>This week</small></div><span class="right-number">${scheduled}</span></div><div class="stat-row"><span class="stat-icon">⇄</span><div><strong>Open swap requests</strong><small>Sent or received</small></div><span class="right-number">${pending}</span></div><div class="stat-row"><span class="stat-icon">♧</span><div><strong>One employee roster</strong><small>People sharing the lunch plan</small></div><span class="right-number">${db.employees.length}</span></div></div></div></div>
    <h2 class="section-title">Today’s lunch slots</h2><div class="team-cards">${db.slots.map((s,i)=>{const c=color(i);return `<div class="team-card"><span class="team-color" style="background:${c.bg};color:${c.fg}">◷</span><strong>${escapeHtml(timeRange(s.id))}</strong><small>${db.employees.filter(e=>assignment(today,e.id)===s.id).length} employees today</small></div>`}).join('')}</div>`;
}

function weekToolbar() { return `<div class="toolbar"><div class="week-picker"><button class="square-button" data-action="prev-week" aria-label="Previous week">‹</button><strong>${weekLabel(selectedWeek)}</strong><button class="square-button" data-action="next-week" aria-label="Next week">›</button></div><div class="toolbar-actions"><button class="button" data-action="today-week">This week</button><button class="button primary" data-action="open-swap">⇄ &nbsp; Request a swap</button></div></div>`; }
function renderSchedule() {
  const dates=weekDates(fromIso(selectedWeek));
  if(!dates.includes(selectedDay)) selectedDay=dates[0];
  return `${heading('WEEKLY OVERVIEW','Full lunch overview','See employees under their lunch time for each day.')}${weekToolbar()}<div class="tabs day-tabs">${dates.map((date,i)=>`<button class="tab ${selectedDay===date?'active':''}" data-day="${date}">${DAYS[i]} <span>${shortDate(date)}</span></button>`).join('')}</div><div class="slot-columns">${db.slots.map((s,i)=>{const people=db.employees.filter(e=>assignment(selectedDay,e.id)===s.id);const c=color(i);return `<section class="slot-column"><div class="slot-column-head"><span class="slot-mark" style="background:${c.bg};color:${c.fg}">◷</span><div><h2>${escapeHtml(timeRange(s.id))}</h2><small>${people.length} ${people.length===1?'employee':'employees'}</small></div></div><div class="slot-people">${people.length?people.map(e=>{const window=lunchWindow(selectedDay,e.id);return `<div class="slot-person">${avatar(e)}<span>${escapeHtml(e.name)}</span>${window?`<span class="away-indicator">Away ${escapeHtml(window.start)} – ${escapeHtml(window.end)}</span>`:''}</div>`;}).join(''):'<div class="slot-empty">No one assigned</div>'}</div></section>`}).join('')}</div><p class="hint">Choose another day above or use the week controls to see its four time slots.</p>`;
}

function renderRequests() {
  const me=currentEmployee(); const relevant=db.requests.filter(r=>r.fromId===me?.id||r.toId===me?.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const shown=relevant.filter(r=>requestTab==='all'||(requestTab==='received'?r.toId===me?.id:r.fromId===me?.id));
  return `${heading('MAKE LUNCH WORK FOR YOU','Swap requests','Manage your lunch swaps with coworkers.',`<button class="button primary" data-action="open-swap">＋ &nbsp; New request</button>`)}<div class="tabs"><button class="tab ${requestTab==='all'?'active':''}" data-tab="all">All requests</button><button class="tab ${requestTab==='received'?'active':''}" data-tab="received">Received</button><button class="tab ${requestTab==='sent'?'active':''}" data-tab="sent">Sent</button></div><div class="request-list">${shown.length?shown.map(r=>{
    const outgoing=r.fromId===me?.id; const other=employee(outgoing?r.toId:r.fromId); const dateText=r.dates.map(shortDate).join(', ');
    return `<div class="request-card">${avatar(other)}<div class="request-body"><strong>${outgoing?'You requested a swap with':`${escapeHtml(other?.name||'Former employee')} requested a swap with you`}${outgoing?' '+escapeHtml(other?.name||'Former employee'):''}</strong><p>${escapeHtml(dateText)} · ${r.dates.length} ${r.dates.length===1?'day':'days'} · Sent ${shortDate(iso(new Date(r.createdAt)))}</p></div><span class="badge ${r.status}">${r.status}</span>${r.status==='pending'&&!outgoing?`<div class="request-actions"><button class="button danger" data-action="decline-request" data-id="${r.id}">Decline</button><button class="button primary" data-action="accept-request" data-id="${r.id}">Accept swap</button></div>`:r.status==='pending'&&outgoing?`<button class="button" data-action="cancel-request" data-id="${r.id}">Cancel</button>`:''}</div>`;
  }).join(''):`<div class="card empty-state"><strong>No swap requests here yet</strong>When a swap is requested, you’ll see it here.</div>`}</div>`;
}

function renderAdmin() {
  return `${heading('WORKSPACE SETUP','Admin settings','Set each employee’s Monday lunch time for the whole week.')}${weekToolbar()}<div class="settings-grid"><div class="card card-pad"><div class="card-head"><h2>Weekly assignments</h2><button class="button soft" data-action="generate-plan">✳ &nbsp; Auto-fill week</button></div><p class="hint">Choose a Monday time; it applies Monday through Friday. Later days show the resulting schedule, including swaps.</p><div class="schedule-wrap"><table class="schedule-table"><thead><tr><th>EMPLOYEE</th>${weekDates(fromIso(selectedWeek)).map((d,i)=>`<th>${DAYS[i].slice(0,3)} <small>${shortDate(d)}</small></th>`).join('')}</tr></thead><tbody>${db.employees.map(e=>`<tr><td><div class="assignment">${avatar(e)}<span>${escapeHtml(e.name)}${e.excludedFromLunch?' (excluded)':''}</span></div></td>${weekDates(fromIso(selectedWeek)).map((d,i)=>`<td><select class="assignment-select" data-date="${d}" data-employee="${e.id}" ${e.excludedFromLunch||i>0?'disabled':''} aria-label="Lunch time for ${escapeHtml(e.name)} on ${d}"><option value="">No lunch</option>${db.slots.map(s=>`<option value="${s.id}" ${assignment(d,e.id)===s.id?'selected':''}>${escapeHtml(timeRange(s.id))}</option>`).join('')}</select></td>`).join('')}</tr>`).join('')}</tbody></table></div></div>
  <div><div class="card card-pad"><div class="card-head"><h2>Lunch time slots</h2></div><div class="settings-list">${db.slots.map((s,i)=>{const c=color(i);return `<div class="slot-row"><span class="stat-icon" style="background:${c.bg};color:${c.fg}">◷</span><div class="row-grow"><strong>${escapeHtml(timeRange(s.id))}</strong><small>30 minute lunch</small></div></div>`}).join('')}</div><div class="note-box">Employees are grouped by these times in the full overview.</div></div>
  <div class="card card-pad" style="margin-top:20px"><div class="card-head"><h2>Employees</h2></div><p class="hint">Set roles and exclude employees who should not receive lunch assignments.</p><div class="settings-list">${db.employees.map(e=>`<div class="member-row">${avatar(e)}<div class="row-grow"><strong>${escapeHtml(e.name)}</strong></div><label class="exclude-control"><input class="employee-excluded" type="checkbox" data-employee="${e.id}" ${e.excludedFromLunch?'checked':''}> Exclude</label><select class="employee-role" data-employee="${e.id}" aria-label="Role for ${escapeHtml(e.name)}"><option value="employee" ${(e.role||'employee')==='employee'?'selected':''}>Employee</option><option value="admin" ${e.role==='admin'?'selected':''}>Administrator</option></select><button class="ghost-icon" data-action="remove-employee" data-id="${e.id}" aria-label="Remove employee">×</button></div>`).join('')}</div><form id="employee-form" class="inline-form"><input name="name" placeholder="Employee name" maxlength="60" required><button class="button soft" type="submit">Add</button></form></div></div></div><h2 class="section-title">Account access</h2><div class="card card-pad"><div class="card-head"><h2>Registered accounts</h2><button class="button" data-action="refresh-users">Refresh</button></div><p class="hint">New accounts cannot use the lunch planner until approved. Approve to create an employee automatically, or select an existing employee to link.</p><div class="settings-list">${adminUsers.map(u=>`<div class="account-row"><div class="row-grow"><strong>${escapeHtml(u.name)}</strong><small>${escapeHtml(u.email)} · ${escapeHtml(u.role)}</small></div>${u.role==='pending'?`<select class="account-employee" data-user="${u.id}" aria-label="Employee for ${escapeHtml(u.name)}"><option value="">Create employee from this account</option>${db.employees.filter(e=>!adminUsers.some(a=>a.employeeId===e.id)).map(e=>`<option value="${e.id}">${escapeHtml(e.name)} · ${e.role==='admin'?'Administrator':'Employee'}</option>`).join('')}</select><button class="button primary" data-action="approve-user" data-id="${u.id}">Approve account</button>`:`<span class="badge accepted">${escapeHtml(employee(u.employeeId)?.name||'Linked')}</span>`}</div>`).join('')}</div></div>`;
}

function renderModal() {
  if(modal.type==='recovery') return `<div class="modal-backdrop" data-action="close-modal"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">Set recovery phrase</h2><p>Use at least 16 characters that only you know. Save it somewhere safe for password resets.</p><form id="recovery-form"><div class="field"><label>Private recovery phrase</label><input name="recoveryPhrase" type="password" autocomplete="off" minlength="16" maxlength="256" required></div><div class="modal-footer"><button type="button" class="button" data-action="close-modal">Cancel</button><button class="button primary" type="submit">Save phrase</button></div></form></div></div>`;
  if(modal.type!=='swap') return '';
  const me=currentEmployee(); const dates=weekDates(fromIso(selectedWeek));
  const choices=db.employees.filter(e=>e.id!==me?.id&&!e.excludedFromLunch);
  return `<div class="modal-backdrop" data-action="close-modal"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">Request a lunch swap</h2><p>Choose a coworker and swap one day, several days, or the full week. They’ll need to accept before the plan changes.</p><form id="swap-form"><div class="field"><label for="swap-with">Swap with</label><select id="swap-with" name="toId" required>${choices.map(e=>`<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('')}</select></div><div class="field"><div class="swap-day-heading"><label>Days to swap · ${weekLabel(selectedWeek)}</label><button type="button" class="text-link" data-action="select-full-week">Select full week</button></div><div class="check-grid">${dates.map((d,i)=>{const available=!!assignment(d,me?.id);return `<label class="check-day ${available?'':'disabled'}"><input type="checkbox" name="dates" value="${d}" ${available?'':'disabled'}><strong>${DAYS[i].slice(0,3)}</strong><small>${shortDate(d)}</small></label>`}).join('')}</div></div><div class="note-box">Both employees need a lunch assignment on every selected day. An accepted request swaps the selected days only.</div><div class="modal-footer"><button type="button" class="button" data-action="close-modal">Cancel</button><button class="button primary" type="submit" ${choices.length?'':'disabled'}>Send request</button></div></form></div></div>`;
}

function toast(message) { const root=document.getElementById('toast-root'); root.innerHTML=`<div class="toast">${escapeHtml(message)}</div>`; clearTimeout(toast.timer); toast.timer=setTimeout(()=>root.innerHTML='',3500); }
function setView(next) { view=next; modal=null; render(); }
function setWeek(next) { const dayIndex=Math.min(4,Math.max(0,(fromIso(selectedDay).getDay()+6)%7)); selectedWeek=iso(weekStart(next)); selectedDay=weekDates(fromIso(selectedWeek))[dayIndex]; render(); }
function ensureWeek() { db.plans[selectedWeek] ||= {}; weekDates(fromIso(selectedWeek)).forEach(d=>db.plans[selectedWeek][d] ||= {}); }
function setWeekAssignment(employeeId,slotId) {
  if(employee(employeeId)?.excludedFromLunch || (slotId && !slot(slotId))) return false;
  ensureWeek();
  weekDates(fromIso(selectedWeek)).forEach(date=>{
    if(slotId) db.plans[selectedWeek][date][employeeId]=slotId;
    else delete db.plans[selectedWeek][date][employeeId];
  });
  return true;
}
function fillWeek() {
  ensureWeek();
  db.employees.filter(person=>!person.excludedFromLunch).forEach((person,i)=>{
    const slotId=db.slots[i%db.slots.length].id;
    weekDates(fromIso(selectedWeek)).forEach(date=>{db.plans[selectedWeek][date][person.id]=slotId;});
  });
  db.employees.filter(person=>person.excludedFromLunch).forEach(person=>{
    weekDates(fromIso(selectedWeek)).forEach(date=>{delete db.plans[selectedWeek][date][person.id];});
  });
}
function swapDays(request) {
  if(request.dates.some(date=>!assignment(date,request.fromId)||!assignment(date,request.toId))) return false;
  request.dates.forEach(date=>{
    const day=db.plans[iso(weekStart(fromIso(date)))][date];
    const previous=day[request.fromId];
    day[request.fromId]=day[request.toId];
    day[request.toId]=previous;
  });
  return true;
}

document.addEventListener('click',e=>{
  const target=e.target.closest('[data-action],[data-view],[data-tab],[data-day]'); if(!target) return;
  if(target.dataset.view) { setView(target.dataset.view); return; }
  if(target.dataset.tab) { requestTab=target.dataset.tab; render(); return; }
  if(target.dataset.day) { selectedDay=target.dataset.day; render(); return; }
  const action=target.dataset.action, id=target.dataset.id;
  if(action==='toggle-auth') { authMode=authMode==='login'?'register':'login'; render(); return; }
  if(action==='show-reset') { authMode='reset'; render(); return; }
  if(action==='show-login') { authMode='login'; render(); return; }
  if(action==='open-recovery') { modal={type:'recovery'}; render(); return; }
  if(action==='logout') { api('/api/logout',{method:'POST',body:'{}'}).finally(()=>{authUser=null;db=initialData();authMode='login';render();}); return; }
  if(action==='refresh-session') { start(); return; }
  if(action==='lunch-now') {
    target.disabled=true;
    api('/api/lunch-now',{method:'POST',body:'{}'}).then(async()=>{await loadState();toast('Away time added beside your name in the weekly view.');}).catch(error=>{target.disabled=false;toast(error.message);});
    return;
  }
  if(action==='refresh-users') { api('/api/users').then(users=>{adminUsers=users;render();}).catch(error=>toast(error.message)); return; }
  if(action==='approve-user') {
    const employeeId=document.querySelector(`.account-employee[data-user="${id}"]`)?.value;
    
    saveQueue.then(()=>api(`/api/users/${encodeURIComponent(id)}/approve`,{method:'POST',body:JSON.stringify({employeeId})})).then(async()=>{await loadState();toast('Account approved.');}).catch(error=>toast(error.message));
    return;
  }
  if(action==='reject-user') {
    if(!confirm('Reject this account registration?')) return;
    saveQueue.then(()=>api(`/api/users/${encodeURIComponent(id)}/reject`,{method:'POST',body:'{}'})).then(async()=>{await loadState();toast('Account rejected.');}).catch(error=>toast(error.message));
    return;
  }
  if(action==='revoke-user') {
    if(!confirm('Revoke this user’s login access immediately?')) return;
    saveQueue.then(()=>api(`/api/users/${encodeURIComponent(id)}/revoke`,{method:'POST',body:'{}'})).then(async()=>{await loadState();toast('Login access revoked.');}).catch(error=>toast(error.message));
    return;
  }
  if(action==='close-modal') { if(e.target!==target && target.classList.contains('modal-backdrop')) return; modal=null; render(); return; }
  if(action==='open-swap') { if(currentEmployee()?.excludedFromLunch) return toast('You are excluded from the lunch plan.'); modal={type:'swap'}; render(); return; }
  if(action==='select-full-week') {
    const recipientId=document.getElementById('swap-with')?.value;
    const dates=weekDates(fromIso(selectedWeek));
    if(dates.some(date=>!assignment(date,db.currentEmployeeId)||!assignment(date,recipientId))) return toast('Both employees need lunch assignments for all five days.');
    document.querySelectorAll('#swap-form input[name="dates"]').forEach(input=>{input.checked=true;});
    return;
  }
  if(action==='prev-week'||action==='next-week') { setWeek(addDays(fromIso(selectedWeek),action==='prev-week'?-7:7)); return; }
  if(action==='today-week') { setWeek(new Date()); return; }
  if(action==='generate-plan') { fillWeek(); save(); render(); toast('One lunch time assigned per employee for the full week.'); return; }
  if(['accept-request','decline-request','cancel-request'].includes(action)) {
    const verb=action.split('-')[0];
    api(`/api/swaps/${encodeURIComponent(id)}/${verb}`,{method:'POST',body:'{}'}).then(async()=>{await loadState();toast(verb==='accept'?'Swap accepted. The plan is updated.':'Request closed.');}).catch(error=>toast(error.message));
    return;
  }
  if(action==='remove-employee') { if(db.employees.length<=1) return toast('Keep at least one employee.'); if(adminUsers.some(u=>u.employeeId===id)) return toast('This employee has a linked account.'); db.employees=db.employees.filter(x=>x.id!==id); for(const week of Object.values(db.plans)) for(const day of Object.values(week)) delete day[id]; save(); render(); toast('Employee removed.'); return; }
});

document.addEventListener('change',e=>{
  if(e.target.matches('.employee-role')) { const person=employee(e.target.dataset.employee); if(!person) return; person.role=e.target.value; save(); toast('Role saved.'); }
  if(e.target.matches('.employee-excluded')) {
    const person=employee(e.target.dataset.employee); if(!person) return;
    person.excludedFromLunch=e.target.checked;
    if(person.excludedFromLunch) {
      const today=iso(new Date());
      for(const week of Object.values(db.plans)) for(const [date,day] of Object.entries(week)) if(date>=today) delete day[person.id];
      for(const week of Object.values(db.lunchNow||{})) for(const [date,day] of Object.entries(week)) if(date>=today) delete day[person.id];
    }
    save(); render(); toast(person.excludedFromLunch?'Employee excluded from lunch plans.':'Employee included in lunch plans.');
  }
  if(e.target.matches('.assignment-select')) {
    const {date,employee:employeeId}=e.target.dataset;
    if(date!==selectedWeek || !setWeekAssignment(employeeId,e.target.value)) return;
    save(); render(); toast('Monday time applied to the whole week.');
  }
});
document.addEventListener('input',e=>{
  if(e.target.name==='password'||e.target.name==='confirmPassword') e.target.form?.elements.confirmPassword?.setCustomValidity('');
});

document.addEventListener('submit',e=>{
  if(!['auth-form','reset-form','recovery-form','employee-form','swap-form'].includes(e.target.id)) return;
  e.preventDefault(); const form=e.target, values=new FormData(form);
  if(form.id==='reset-form') {
    api('/api/reset-password',{method:'POST',body:JSON.stringify({email:values.get('email'),recoveryPhrase:values.get('recoveryPhrase'),password:values.get('password')})}).then(()=>{authMode='login';render();toast('Password reset. Sign in with your new password.');}).catch(error=>toast(error.message));
    return;
  }
  if(form.id==='recovery-form') {
    api('/api/recovery-phrase',{method:'POST',body:JSON.stringify({recoveryPhrase:values.get('recoveryPhrase')})}).then(()=>{modal=null;render();toast('Recovery phrase saved.');}).catch(error=>toast(error.message));
    return;
  }
  if(form.id==='auth-form') {
    const mode=values.get('mode');
    const body={email:values.get('email'),password:values.get('password')};
    if(mode==='register') {
      body.name=values.get('name'); body.recoveryPhrase=values.get('recoveryPhrase');
      body.confirmPassword=values.get('confirmPassword');
      if(body.password!==body.confirmPassword) { form.elements.confirmPassword.setCustomValidity('Passwords do not match'); form.elements.confirmPassword.reportValidity(); return; }
    }
    api(`/api/${mode}`,{method:'POST',body:JSON.stringify(body)}).then(async result=>{
      authUser=result.user; firstUser=false;
      if(authUser.role==='pending') render();
      else { view=authUser.role==='admin'?'admin':'overview'; await loadState(); }
    }).catch(error=>toast(error.message));
    return;
  }
  if(form.id==='employee-form') { const name=String(values.get('name')).trim(); if(!name) return; db.employees.push({id:uid(),name,role:'employee'}); toast('Employee added.'); }
  if(form.id==='swap-form') {
    const fromId=db.currentEmployeeId,toId=values.get('toId'),dates=values.getAll('dates');
    if(!employee(toId)||fromId===toId||!dates.length) return toast('Choose a coworker and at least one day.');
    if(dates.some(d=>!weekDates(fromIso(selectedWeek)).includes(d)||!assignment(d,fromId)||!assignment(d,toId))) return toast('Both employees need a lunch time on each day.');
    api('/api/swaps',{method:'POST',body:JSON.stringify({toId,dates})}).then(async()=>{modal=null;view='requests';requestTab='sent';await loadState();toast('Swap request sent.');}).catch(error=>toast(error.message));
    return;
  }
  save(); render();
});

document.getElementById('notification-button').addEventListener('click',()=>{requestTab='received';setView('requests');});
async function start() {
  try {
    const session=await api('/api/session');
    authUser=session.user; firstUser=session.firstUser;
    if(authUser?.role==='admin') view='admin';
    if(authUser && authUser.role!=='pending') {
      await loadState();
      if(authUser.role==='admin' && migrateTimeSlots()) { save(); render(); }
    } else render();
  } catch(error) { console.error(error); toast('Could not connect to the local server.'); renderAuth(); }
}
start();
setInterval(()=>{if(authUser&&authUser.role!=='pending'&&view==='overview'&&!modal) render();},30_000);
