const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function appContext() {
  const source = fs.readFileSync(require('node:path').join(__dirname, 'app.js'), 'utf8');
  const context = vm.createContext({
    localStorage: { getItem: () => null, setItem: () => {} },
    Date, Intl, Math, String, Number, Object, Array
  });
  vm.runInContext(source.split("document.addEventListener('click'")[0], context);
  return context;
}

test('four fixed half-hour slots are used for the employee roster', () => {
  const context = appContext();
  const slots = vm.runInContext('db.slots.map(s => timeRange(s.id))', context);
  assert.deepEqual(Array.from(slots), [
    '11:00 – 11:30', '11:30 – 12:00', '12:00 – 12:30', '12:30 – 13:00'
  ]);
  assert.equal(vm.runInContext('db.teams.length', context), 0);
  assert.ok(vm.runInContext('assignment(weekDates(fromIso(selectedWeek))[0], "e1")', context));
});

test('saved group assignments migrate to the matching time slot', () => {
  const context = appContext();
  vm.runInContext('db.slots=[{id:"s1",start:"11:30",duration:30}]; db.teams=[{id:"t1",name:"Team 1"}]; db.plans[selectedWeek][weekDates(fromIso(selectedWeek))[0]].e1={groupId:"t1",slotId:"s1"}; migrateTimeSlots()', context);
  assert.equal(vm.runInContext('db.teams.length', context), 0);
  assert.equal(vm.runInContext('slot(assignment(weekDates(fromIso(selectedWeek))[0],"e1")).start', context), '11:30');
});

test('overview renders four columns headed by the time ranges', () => {
  const context = appContext();
  const html = vm.runInContext('renderSchedule()', context);
  assert.equal((html.match(/class="slot-column"/g)||[]).length, 4);
  assert.match(html, /11:00 – 11:30/);
  assert.match(html, /12:30 – 13:00/);
});

test('weekly plan shows the saved lunch-now window beside the employee', () => {
  const context = appContext();
  const html = vm.runInContext(`(() => {
    const date=weekDates(fromIso(selectedWeek))[0];
    selectedDay=date;
    db.lunchNow={[selectedWeek]:{[date]:{e1:{slotId:assignment(date,'e1'),start:'11:35',end:'12:05'}}}};
    return renderSchedule();
  })()`, context);
  assert.match(html, /Alex Chen<\/span><span class="away-indicator">Away 11:35 – 12:05/);
  assert.match(html, /11:00 – 11:30/);
});

test('lunch-now button is available only during the assigned slot and before use', () => {
  const context = appContext();
  const available = vm.runInContext(`(() => {
    const at=(hour,minute)=>new Date(2026,0,5,hour,minute);
    return [lunchNowAvailable(at(10,59),'slot0',null),lunchNowAvailable(at(11,15),'slot0',null),lunchNowAvailable(at(11,30),'slot0',null),lunchNowAvailable(at(11,15),'slot0',{start:'11:15'})];
  })()`, context);
  assert.deepEqual(Array.from(available), [false,true,false,false]);
});

test('auto-fill gives each employee one time slot for Monday through Friday', () => {
  const context = appContext();
  vm.runInContext('fillWeek()', context);
  const slots = vm.runInContext('weekDates(fromIso(selectedWeek)).map(date => assignment(date,"e1"))', context);
  assert.equal(new Set(slots).size, 1);
  assert.equal(slots.length, 5);
});

test('a Monday assignment sets or clears every weekday for that employee', () => {
  const context = appContext();
  const result = vm.runInContext(`(() => {
    const dates=weekDates(fromIso(selectedWeek));
    setWeekAssignment('e1','slot1');
    const assigned=dates.map(date=>assignment(date,'e1'));
    setWeekAssignment('e1','');
    return {assigned,cleared:dates.map(date=>assignment(date,'e1'))};
  })()`, context);
  assert.deepEqual(Array.from(result.assigned), ['slot1','slot1','slot1','slot1','slot1']);
  assert.deepEqual(Array.from(result.cleared), [null,null,null,null,null]);
});

test('excluded employees receive no auto-fill assignment', () => {
  const context = appContext();
  const result = vm.runInContext(`(() => {
    db.employees[0].excludedFromLunch=true;
    fillWeek();
    const dates=weekDates(fromIso(selectedWeek));
    return {excluded:dates.map(date=>assignment(date,'e1')),next:dates.map(date=>assignment(date,'e2'))};
  })()`, context);
  assert.deepEqual(Array.from(result.excluded), [null,null,null,null,null]);
  assert.deepEqual(Array.from(result.next), ['slot0','slot0','slot0','slot0','slot0']);
});

test('a one-day swap changes only that day', () => {
  const context = appContext();
  vm.runInContext('fillWeek()', context);
  const result = vm.runInContext(`(() => {
    const dates=weekDates(fromIso(selectedWeek));
    const before=dates.map(date=>assignment(date,'e1'));
    const other=assignment(dates[2],'e2');
    swapDays({fromId:'e1',toId:'e2',dates:[dates[2]]});
    return {before,after:dates.map(date=>assignment(date,'e1')),other};
  })()`, context);
  assert.equal(result.after[2], result.other);
  assert.equal(result.after[0], result.before[0]);
  assert.equal(result.after[4], result.before[4]);
});

test('a full-week swap changes all five days', () => {
  const context = appContext();
  vm.runInContext('fillWeek()', context);
  const result = vm.runInContext(`(() => {
    const dates=weekDates(fromIso(selectedWeek));
    const other=dates.map(date=>assignment(date,'e2'));
    const swapped=swapDays({fromId:'e1',toId:'e2',dates});
    return {swapped,other,after:dates.map(date=>assignment(date,'e1'))};
  })()`, context);
  assert.equal(result.swapped, true);
  assert.deepEqual(Array.from(result.after), Array.from(result.other));
});
