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
test('nested unchecked items only, excluding completed and fenced examples',()=>{
  const {c}=harness();const p=c.parseTasks_('---\nx: 1\n---\n## 업무\n- [ ] A\n- [x] B\n- [X] C\n~~~md\n- [ ] fake\n~~~\n## 개인\n  - [ ] D');
  assert.deepEqual(Array.from(p.tasks,t=>t.text),['A','D']);
});
test('dates and stars remain plain text without affecting order',()=>{
  const {c}=harness();const text='- [ ] A\n- [ ] B 📅 2026-02-30\n- [ ] C ⭐\n- [ ] D 📅 2026-01-01';
  const body=c.buildDigest_({text,modified:'bad'},'/x.md','2026-09-10').body;
  assert.deepEqual(body.split('\n').filter(l=>l.startsWith('• ')),['• A','• B 📅 2026-02-30','• C ⭐','• D 📅 2026-01-01']);
  assert.doesNotMatch(body,/기록 확인|기한 초과|오늘 마감|중요 표시|노트 순서|이어서 할 일|오늘 우선할 일|\[기타\]|\[업무\]/);
});
test('all tasks included with no top-three or five-item limit',()=>{
  const {c}=harness();const text=Array.from({length:20},(_,i)=>'- [ ] task '+i).join('\n');
  const digest=c.buildDigest_({text,modified:'bad'},'/x.md','2026-09-10');
  assert.deepEqual(digest.body.split('\n').filter(l=>l.startsWith('• ')),Array.from({length:20},(_,i)=>'• task '+i));
  assert.match(digest.subject,/미완료 20개/);assert.equal(digest.body.split('남은 할 일').length,2);
});
test('empty or fully completed note',()=>{
  const {c}=harness();for(const text of ['', '- [x] done']) {
    const digest=c.buildDigest_({text,modified:'bad'},'/x.md','2026-09-10');assert.match(digest.body,/등록된 미완료/);assert.match(digest.subject,/미완료 0개/);
  }
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
