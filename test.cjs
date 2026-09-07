const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(__dirname + '/Code.gs', 'utf8');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function harness(hour = '0700') {
  const state = {properties: {RECIPIENT_EMAIL:'me@example.com', DROPBOX_NOTE_PATH:'/보관함/오늘의 할 일.md', DROPBOX_APP_KEY:'key', DROPBOX_APP_SECRET:'secret', DROPBOX_REFRESH_TOKEN:'refresh'}, mails:[], calls:[], locks:0, failRead:false, failSend:false, triggers:[]};
  const properties = {getProperty:k=>state.properties[k] || null, setProperty:(k,v)=>{state.properties[k]=v;}, setProperties:o=>Object.assign(state.properties,o), deleteProperty:k=>delete state.properties[k]};
  const context = vm.createContext({console, PropertiesService:{getScriptProperties:()=>properties}, Utilities:{formatDate:(date,tz,format)=>format==='HHmm'?hour:format==='yyyy-MM-dd'?'2026-09-10':'2026-09-09 21:00:00'}, LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>state.locks++})}, MailApp:{getRemainingDailyQuota:()=>10, sendEmail:m=>{state.mails.push(m);if(state.failSend)throw Error('ambiguous');}}, UrlFetchApp:{fetch:(url,options)=>{state.calls.push({url,options});const token=url.endsWith('/token');return {getResponseCode:()=>!token&&state.failRead?409:200,getContentText:()=>token?JSON.stringify({access_token:'access',refresh_token:'new-refresh'}):'## 업무\n- [ ] 보고서 📅 2026-09-10',getAllHeaders:()=>({'Dropbox-API-Result':JSON.stringify({server_modified:'2026-09-09T12:00:00Z'})})};}}, ScriptApp:{getProjectTriggers:()=>state.triggers,deleteTrigger:t=>{state.triggers=state.triggers.filter(x=>x!==t);},newTrigger:name=>({timeBased:()=>({everyMinutes:n=>({create:()=>{assert.equal(n,5);state.triggers.push({getHandlerFunction:()=>name});}})})})}});
  vm.runInContext(source,context);
  return {state,c:context};
}
test('checkboxes, categories, completed and fenced examples',()=>{
  const {c}=harness();const p=c.parseTasks_('---\nx: 1\n---\n## 업무\n- [ ] A\n- [x] B\n- [X] C\n```md\n- [ ] fake\n```\n## 개인\n  - [ ] D');
  assert.equal(p.tasks.length,2);assert.equal(p.tasks[1].category,'개인');
});
test('valid dates, leap years and warnings',()=>{
  const {c}=harness();assert.equal(c.validDate_('2026-02-29'),false);assert.equal(c.validDate_('2028-02-29'),true);
  const p=c.parseTasks_('- [ ] A 📅 2026-02-30\n- [ ] B 📅 2026-09-10 📅 2026-09-11');assert.equal(p.warnings.length,2);assert.equal(p.tasks[0].due,null);
});
test('priority order, date order and no duplicated sections',()=>{
  const {c}=harness();const p=c.parseTasks_('- [ ] no date\n- [ ] future 📅 2026-10-01\n- [ ] star ⭐\n- [ ] today 📅 2026-09-10\n- [ ] late 📅 2026-09-09\n- [ ] older 📅 2026-09-08\n- [ ] today2 📅 2026-09-10');
  const g=c.selectTasks_(p.tasks,'2026-09-10');assert.deepEqual(Array.from(g.top,t=>t.line),[6,5,4]);assert.equal(g.deadlines.length,1);assert.equal(g.next[0].important,true);
  assert.equal(new Set([...g.top,...g.deadlines,...g.next].map(t=>t.line)).size,7);
});
test('empty note and remaining count',()=>{
  const {c}=harness();assert.match(c.buildDigest_({text:'',modified:'bad'},'/x.md','2026-09-10').body,/등록된 미완료/);
  const g=c.selectTasks_(c.parseTasks_(Array.from({length:12},(_,i)=>'- [ ] task '+i).join('\n')).tasks,'2026-09-10');assert.equal(g.next.length,5);assert.equal(g.remaining,4);
});
test('before 07:00 performs no network calls or sends',()=>{
  const {c,state}=harness('0659');c.scheduledDigest();assert.equal(state.calls.length,0);assert.equal(state.mails.length,0);
});
test('daily suppression and token refresh with ASCII Korean header',()=>{
  const {c,state}=harness();c.scheduledDigest();c.scheduledDigest();assert.equal(state.mails.length,1);assert.equal(state.calls.length,2);assert.equal(state.calls[0].options.payload.grant_type,'refresh_token');
  const header=state.calls[1].options.headers['Dropbox-API-Arg'];assert.match(header,/^[\x00-\x7f]+$/);assert.equal(JSON.parse(header).path,state.properties.DROPBOX_NOTE_PATH);assert.equal(state.properties.LAST_STATUS,'sent');assert.equal(state.locks,2);
});
test('Dropbox failure sends one failure notice, not empty digest',()=>{
  const {c,state}=harness();state.failRead=true;c.scheduledDigest();c.scheduledDigest();assert.equal(state.mails.length,1);assert.match(state.mails[0].subject,/확인 실패/);assert.doesNotMatch(state.mails[0].body,/secret|refresh/);
});
test('ambiguous send is not retried',()=>{
  const {c,state}=harness();state.failSend=true;assert.throws(()=>c.scheduledDigest(),/발송 결과 불명/);c.scheduledDigest();assert.equal(state.mails.length,1);assert.equal(state.properties.LAST_STATUS,'delivery_uncertain');
});
test('read-only preview does not send or mark daily attempt',()=>{
  const {c,state}=harness();c.console={log:()=>{}};c.previewDigest();assert.equal(state.mails.length,0);assert.equal(state.properties.LAST_ATTEMPT_DATE,undefined);
});
test('authorization code exchange stores refresh token and removes code',()=>{
  const {c,state}=harness();state.properties.DROPBOX_AUTH_CODE='code';c.exchangeAuthorizationCode();assert.equal(state.properties.DROPBOX_REFRESH_TOKEN,'new-refresh');assert.equal(state.properties.DROPBOX_AUTH_CODE,undefined);assert.equal(state.mails.length,0);
});
test('installation replaces only owned trigger and sends nothing',()=>{
  const {c,state}=harness();state.triggers.push({getHandlerFunction:()=> 'unrelated'});c.installSchedule();c.installSchedule();assert.equal(state.triggers.length,2);assert.equal(state.mails.length,0);c.removeSchedule();assert.equal(state.triggers.length,1);
});
test('multiple recipients rejected',()=>{
  const {c,state}=harness();state.properties.RECIPIENT_EMAIL='a@example.com,b@example.com';assert.throws(()=>c.config_());
});
console.log(passed + ' tests passed; no real network or email used.');
