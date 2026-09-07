/* Dropbox Obsidian morning digest. No external libraries. */
const TZ = 'Asia/Seoul';

function props_() { return PropertiesService.getScriptProperties(); }
function required_(name) {
  const value = props_().getProperty(name);
  if (!value || !value.trim()) throw new Error('설정 누락: ' + name);
  return value.trim();
}
function config_() {
  const recipient = required_('RECIPIENT_EMAIL');
  const path = required_('DROPBOX_NOTE_PATH');
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(recipient)) throw new Error('수신 주소는 한 개여야 합니다.');
  if (!path.startsWith('/') || !path.endsWith('.md')) throw new Error('Dropbox 경로는 /로 시작하는 .md 경로여야 합니다.');
  required_('DROPBOX_APP_KEY'); required_('DROPBOX_APP_SECRET'); required_('DROPBOX_REFRESH_TOKEN');
  return {recipient: recipient, path: path};
}

// Run manually during setup. Only the public authorization URL is logged.
function showAuthorizationUrl() {
  console.log('https://www.dropbox.com/oauth2/authorize?response_type=code&token_access_type=offline&scope=files.content.read&client_id=' + encodeURIComponent(required_('DROPBOX_APP_KEY')));
}
function tokenRequest_(payload) {
  payload.client_id = required_('DROPBOX_APP_KEY');
  payload.client_secret = required_('DROPBOX_APP_SECRET');
  const response = UrlFetchApp.fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'post', payload: payload, muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) throw new Error('Dropbox 인증 실패 (HTTP ' + response.getResponseCode() + ')');
  const result = JSON.parse(response.getContentText());
  if (!result.access_token) throw new Error('Dropbox 액세스 토큰 누락');
  return result;
}
function exchangeAuthorizationCode() {
  const result = tokenRequest_({grant_type: 'authorization_code', code: required_('DROPBOX_AUTH_CODE')});
  if (!result.refresh_token) throw new Error('offline 권한으로 다시 인증하세요.');
  props_().setProperty('DROPBOX_REFRESH_TOKEN', result.refresh_token);
  props_().deleteProperty('DROPBOX_AUTH_CODE');
  console.log('갱신 토큰 저장 완료. 메일은 발송하지 않았습니다.');
}
function downloadNote_(path) {
  const token = tokenRequest_({grant_type: 'refresh_token', refresh_token: required_('DROPBOX_REFRESH_TOKEN')}).access_token;
  // Dropbox API headers require ASCII; escape Korean and other Unicode code units.
  const argument = JSON.stringify({path: path}).replace(/[\u007f-\uffff]/g, function(c) {
    return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
  });
  const response = UrlFetchApp.fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'post', headers: {Authorization: 'Bearer ' + token, 'Dropbox-API-Arg': argument}, muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) throw new Error('Dropbox 노트 읽기 실패 (HTTP ' + response.getResponseCode() + ')');
  const headers = response.getAllHeaders();
  const key = Object.keys(headers).find(function(k) { return k.toLowerCase() === 'dropbox-api-result'; });
  if (!key) throw new Error('Dropbox 파일 정보 누락');
  const metadata = JSON.parse(headers[key]);
  return {text: response.getContentText('UTF-8'), modified: metadata.server_modified};
}

function parseTasks_(markdown) {
  const tasks = [];
  let fence = null, frontmatter = false;
  markdown.replace(/^\uFEFF/, '').split(/\r?\n/).forEach(function(line, index) {
    if (index === 0 && line.trim() === '---') { frontmatter = true; return; }
    if (frontmatter) { if (/^(---|\.\.\.)$/.test(line.trim())) frontmatter = false; return; }
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      return;
    }
    if (fence) return;
    const match = line.match(/^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s+(.+?)\s*$/);
    if (!match) return;
    tasks.push({text: match[1]});
  });
  return {tasks: tasks};
}
function buildDigest_(note, path, today) {
  const parsed = parseTasks_(note.text);
  const lines = [today + ' 오늘 할 일', '미완료 ' + parsed.tasks.length + '개', '', '남은 할 일'];
  if (!parsed.tasks.length) lines.push('등록된 미완료 할 일이 없습니다.');
  parsed.tasks.forEach(function(task) { lines.push('• ' + task.text); });
  lines.push('');
  lines.push('노트 열기: https://www.dropbox.com/home' + path.split('/').map(encodeURIComponent).join('/'));
  const modified = new Date(note.modified);
  lines.push('Dropbox 마지막 수정: ' + (isNaN(modified.getTime()) ? '확인 불가' : Utilities.formatDate(modified, TZ, 'yyyy-MM-dd HH:mm:ss')) + ' (한국 시간)');
  lines.push('마지막 수정 시각은 현재 동기화 상태를 보장하지 않습니다.');
  return {subject: '[오늘 할 일] ' + today + ' · 미완료 ' + parsed.tasks.length + '개', body: lines.join('\n')};
}

// Read and render only. No email or trigger is created. Task text appears in execution logs.
function previewDigest() {
  const cfg = config_();
  const digest = buildDigest_(downloadNote_(cfg.path), cfg.path, Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'));
  console.log(digest.subject + '\n\n' + digest.body);
  return digest;
}
function scheduledDigest() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const now = new Date(), today = Utilities.formatDate(now, TZ, 'yyyy-MM-dd');
    if (Number(Utilities.formatDate(now, TZ, 'HHmm')) < 700) return;
    if (props_().getProperty('LAST_ATTEMPT_DATE') === today) return;
    const cfg = config_();
    let digest;
    try { digest = buildDigest_(downloadNote_(cfg.path), cfg.path, today); }
    catch (error) {
      // Never include raw HTTP responses, credentials, or fetched content in an error email.
      digest = {subject: '[오늘 할 일] ' + today + ' · 확인 실패', body: 'Dropbox 노트를 확인하지 못했습니다. 할 일이 없는 것으로 처리하지 않았습니다.\nApps Script 설정의 인증 정보, 파일 경로, Dropbox 연결 상태를 확인하세요.\n다음 정기 확인은 내일 오전입니다.'};
    }
    if (MailApp.getRemainingDailyQuota() < 1) throw new Error('메일 발송 할당량 부족');
    // At-most-once attempt: an ambiguous delivery failure is not automatically retried.
    props_().setProperties({LAST_ATTEMPT_DATE: today, LAST_STATUS: 'sending'});
    try {
      MailApp.sendEmail({to: cfg.recipient, subject: digest.subject, body: digest.body, name: '아침 할 일'});
      props_().setProperty('LAST_STATUS', 'sent');
    } catch (error) {
      props_().setProperty('LAST_STATUS', 'delivery_uncertain');
      throw new Error('메일 발송 결과 불명. 중복 방지를 위해 오늘 자동 재시도하지 않습니다. Gmail에서 수신 여부를 확인하세요.');
    }
  } finally { lock.releaseLock(); }
}
// Explicit activation only. Does not send immediately.
function installSchedule() {
  config_();
  removeSchedule();
  ScriptApp.newTrigger('scheduledDigest').timeBased().everyMinutes(5).create();
  console.log('매일 07:00 이후 발송하도록 예약했습니다.');
}
function removeSchedule() {
  ScriptApp.getProjectTriggers().filter(function(t) { return t.getHandlerFunction() === 'scheduledDigest'; }).forEach(function(t) { ScriptApp.deleteTrigger(t); });
}
