export function browserScript(mode = 'access') {
  return (mode === 'oidc' ? String.raw`
const oidc = true;
function sessionHeaders() {
  try {
    const token = localStorage.getItem('authToken');
    return token ? { authorization: 'Bearer ' + token } : {};
  } catch { return {}; }
}
` : `const oidc = false;\nfunction sessionHeaders() { return {}; }\n`) + String.raw`
const byId = id => document.getElementById(id);
let pollTimer, pollGeneration = 0, accountGeneration = 0, accountLoaded = false, activeProvider;
let pageVisible = true;
window.addEventListener('pagehide', () => { pageVisible = false; pollGeneration++; accountGeneration++; clearTimeout(pollTimer); });
const status = byId('status');
let authenticated = !oidc;
let canRefreshMetadata = false;
function controls(enabled) {
  authenticated = enabled;
  for (const id of ['setup-start', 'setup-complete', 'setup-device']) if (byId(id)) byId(id).disabled = !enabled;
  byId('metadata-refresh').disabled = !enabled || !canRefreshMetadata;
}

async function post(path, value) {
  const response = await fetch('/gatekeeper/subscription/' + path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', ...sessionHeaders() }, body: JSON.stringify(value), cache: 'no-store', referrerPolicy: 'no-referrer' });
  const result = await response.json();
  if (!response.ok) {
    if (oidc && (response.status === 401 || response.status === 403)) {
      controls(false);
      byId('sign-in').hidden = false;
      byId('authorization').hidden = true;
      byId('login').removeAttribute('href');
      byId('identity').textContent = '';
      byId('metadata-refresh').hidden = true;
      pollGeneration++; accountGeneration++; clearTimeout(pollTimer);
      byId('device').hidden = true; byId('device-code').textContent = ''; byId('device-login').removeAttribute('href'); byId('account-info').textContent = '';
    }
    throw Error(result.error || 'request_failed');
  }
  controls(true);
  byId('sign-in').hidden = true;
  return result;
}
function show(value) {
  if (activeProvider !== value.provider) { accountLoaded = false; accountGeneration++; byId('account-info').textContent = ''; }
  activeProvider = value.provider;
  const ready = value.inferenceReady ?? value.siwcInferenceReady;
  status.textContent = ready ? (value.loginPending ? '기존 연결을 사용할 수 있습니다. 새 로그인은 아래에서 완료하세요.' : '연결 준비 완료. Cloudflare OS의 모델 연결에서 사용할 수 있습니다.') : value.loginPending ? '로그인 진행 중. 아래에서 완료하세요.' : '새 ChatGPT 연결이 필요합니다.';
  const identity = value.identity;
  const absent = '제공되지 않음';
  byId('identity').textContent = identity ? [
    '이름: ' + (identity.name || absent), '이메일: ' + identity.email,
    '요금제: ' + (identity.planType || absent), '워크스페이스: ' + (identity.workspaceName || absent),
    '조직: ' + (identity.organizationNames?.filter(Boolean).join(', ') || absent),
    '마지막 인증 확인: ' + (identity.verifiedAt ? new Date(identity.verifiedAt).toLocaleString() : absent),
  ].join('\n') : '';
  canRefreshMetadata = ready;
  byId('active-provider').textContent = ready ? '현재 모델 연결: ' + (value.provider === 'codex' ? 'Codex device' : 'SIWC') : '';
  for (const provider of ['siwc', 'codex']) { const button = byId('select-' + provider); if (button) { button.hidden = !(provider === 'siwc' ? value.siwcInferenceReady : value.codexInferenceReady) || value.provider === provider; } }
  if (value.device) resumeDevice(value.device);
  else { pollGeneration++; clearTimeout(pollTimer); byId('device').hidden = true; byId('device-code').textContent = ''; byId('device-login').removeAttribute('href'); }
  if (value.deviceFailed) status.textContent += ' 디바이스 로그인은 종료되었습니다. 다시 시작하거나 SIWC를 사용할 수 있습니다.';
  if (ready && !accountLoaded) { accountLoaded = true; loadAccount(); }
  byId('metadata-refresh').hidden = !canRefreshMetadata;
  byId('metadata-refresh').disabled = !authenticated || !canRefreshMetadata;
  if (value.identityRefreshStatus === 'updated') status.textContent += ' 인증 정보를 새로 확인했습니다.';
  if (value.identityRefreshStatus === 'not_returned') status.textContent += ' 새 인증 정보가 제공되지 않아 마지막 확인 정보를 표시합니다.';
}
function resumeDevice(attempt) {
  pollGeneration++; clearTimeout(pollTimer);
  if (!pageVisible || !authenticated || attempt.verificationUrl !== 'https://auth.openai.com/codex/device') return;
  const expiresAt = Date.parse(attempt.expiresAt), nextAt = Date.parse(attempt.nextCheckAt);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(nextAt) || expiresAt <= Date.now()) { byId('device').hidden = true; return; }
  byId('device-code').textContent = attempt.userCode;
  byId('device-login').href = attempt.verificationUrl;
  byId('device').hidden = false;
  const generation = pollGeneration;
  pollTimer = setTimeout(async () => {
    if (!pageVisible || generation !== pollGeneration) return;
    if (Date.now() >= expiresAt) { byId('device').hidden = true; byId('device-code').textContent = ''; byId('device-login').removeAttribute('href'); status.textContent = '디바이스 로그인이 만료되었습니다. 다시 시작하세요.'; return; }
    try { const value = await post('device/check', {}); if (generation === pollGeneration && pageVisible) { if (!value.device) accountLoaded = false; show(value); } }
    catch (error) { if (generation === pollGeneration && pageVisible) { byId('device').hidden = true; byId('device-code').textContent = ''; byId('device-login').removeAttribute('href'); failed(error); } }
  }, Math.max(1000, Math.min(nextAt - Date.now(), expiresAt - Date.now())));
}
async function loadAccount() {
  const generation = ++accountGeneration;
  try {
    const value = await post('account-info', {});
    if (!pageVisible || generation !== accountGeneration) return;
    const account = value.account, usage = value.usage;
    const lines = [];
    if (account?.status === 'available') { if (account.workspaceName) lines.push('선택한 워크스페이스: ' + account.workspaceName); if (account.structure) lines.push('워크스페이스 유형: ' + account.structure); }
    const plan = usage?.status === 'available' ? usage.planType : account?.status === 'available' ? account.planType : null;
    if (plan) lines.push('현재 요금제: ' + plan);
    if (usage?.status === 'available') {
      for (const [label, window] of [['주 사용 한도', usage.primaryWindow], ['추가 사용 한도', usage.secondaryWindow]]) if (window) lines.push(label + ': ' + (window.usedPercent === null ? '제공되지 않음' : window.usedPercent + '% 사용') + (window.resetAt ? ' · 초기화 ' + new Date(window.resetAt * 1000).toLocaleString() : ''));
      if (usage.credits) lines.push('크레딧: ' + (usage.credits.unlimited ? '무제한' : usage.credits.balance ?? (usage.credits.hasCredits ? '있음' : '없음')));
    } else lines.push('사용량 조회: 제공되지 않거나 조회할 수 없습니다. 로그인 연결은 유지됩니다.');
    if (value.checkedAt) lines.push('조회 시각: ' + new Date(value.checkedAt).toLocaleString());
    byId('account-info').textContent = lines.join('\n');
  } catch { if (pageVisible && generation === accountGeneration) byId('account-info').textContent = '계정·사용량을 조회하지 못했습니다. 로그인 연결은 유지됩니다.'; }
}
for (const provider of ['siwc', 'codex']) byId('select-' + provider)?.addEventListener('click', async () => {
  try { show(await post('select', { provider })); } catch (error) { failed(error); }
});
byId('device-start')?.addEventListener('submit', async event => {
  event.preventDefault(); if (!authenticated) return;
  const button = byId('device-start-button'); button.disabled = true;
  try { const attempt = await post('device/start', { planUsageConfirmed: byId('device-approval').checked }); resumeDevice(attempt); status.textContent = 'OpenAI 페이지에서 코드를 입력하고 승인하세요. 이 화면이 완료 여부를 확인합니다. 기존 연결은 유지됩니다.'; }
  catch (error) { failed(error); }
  finally { button.disabled = !authenticated; }
});
function failed(error) { status.textContent = '처리하지 못했습니다. 오류 코드: ' + error.message; }
byId('start').addEventListener('submit', async event => {
  event.preventDefault();
  if (!authenticated) return;
  const button = byId('start-button');
  button.disabled = true;
  byId('authorization').hidden = true;
  try {
    const result = await post('start', { planUsageConfirmed: byId('approval').checked });
    byId('login').href = result.authorizationUrl;
    byId('authorization').hidden = false;
    status.textContent = 'OpenAI 로그인에서 사용할 계정과 워크스페이스를 선택하세요. 기존 연결이 있으면 같은 계정과 워크스페이스로 다시 로그인하세요. 연결 시도는 10분 뒤 만료됩니다.';
  } catch (error) { failed(error); }
  finally { button.disabled = false; }
});
byId('complete').addEventListener('submit', async event => {
  event.preventDefault();
  if (!authenticated) return;
  const button = byId('complete-button');
  const callbackUrl = byId('callback').value;
  byId('callback').value = '';
  button.disabled = true;
  try {
    accountLoaded = false; show(await post('complete', { callbackUrl }));
    byId('login').removeAttribute('href');
    byId('authorization').hidden = true;
  } catch (error) { failed(error); }
  finally { button.disabled = false; }
});
byId('refresh').addEventListener('click', () => post('status', {}).then(show).catch(failed));
byId('metadata-refresh').addEventListener('click', async () => {
  if (!authenticated || !canRefreshMetadata) return;
  byId('metadata-refresh').disabled = true;
  try { accountLoaded = false; show(await post('refresh', {})); }
  catch (error) { failed(error); }
  finally { byId('metadata-refresh').disabled = !authenticated || !canRefreshMetadata; }
});
post('status', {}).then(show).catch(failed);
`;
}

export function subscriptionPage(nonce, mode = 'access', dual = false) {
  const disabled = mode === 'oidc' ? ' disabled' : '';
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>ChatGPT 구독 연결</title>
<style nonce="${nonce}">body{font:18px/1.6 system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem;color:#17212b;background:#fafafa}textarea{box-sizing:border-box;width:100%;padding:.7rem;font:inherit}button,a{font:inherit}button{padding:.5rem 1rem;margin:.5rem 0}label{display:block;margin:.7rem 0}fieldset{border:1px solid #b8c2ca;padding:1rem;margin:1rem 0}a{color:#0645ad}#status{padding:1rem;background:#eaf1f8}#identity,#account-info{white-space:pre-line}small{display:block}</style>
<main><h1>개인 ChatGPT 구독 연결</h1><p id="status" role="status" aria-live="polite">연결 상태를 확인하고 있습니다.</p><p id="active-provider"></p><p id="identity" aria-live="polite"></p><p id="account-info" aria-live="polite"></p>${dual ? '<button id="select-siwc" type="button" hidden>SIWC 연결 사용</button><button id="select-codex" type="button" hidden>Codex device 연결 사용</button>' : ''}<button id="metadata-refresh" type="button" hidden disabled>계정 정보 새로 확인</button><p>SIWC는 전체 구독 사용량을 제공하지 않습니다. Codex device 연결에서는 제공되는 사용 한도를 자동 조회합니다. <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">ChatGPT 설정에서 사용량 확인</a></p><p id="sign-in" hidden><a href="/">OS 로그인</a></p><button id="refresh" type="button">상태 다시 확인</button>
<form id="start" autocomplete="off"><fieldset id="setup-start"${disabled}><legend>SIWC · ChatGPT 로그인</legend><p>이메일을 입력할 필요 없이 OpenAI에서 계정을 선택하세요. 이메일·요금제·조직은 인증된 로그인 결과에 제공된 정보만 표시합니다.</p><label><input id="approval" type="checkbox" required> 이 연결을 통한 모델 요청이 내 ChatGPT 구독 사용량을 사용할 수 있음에 동의합니다.</label><button id="start-button" type="submit">ChatGPT로 계속</button></fieldset></form>
<section id="authorization" hidden><h2>2. 직접 로그인</h2><p><a id="login" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">OpenAI 로그인 열기</a></p><p>OpenAI에서 사용할 계정과 워크스페이스를 선택하세요. 기존 연결을 다시 인증할 때는 같은 계정과 워크스페이스를 사용하세요.</p></section>
<form id="complete" autocomplete="off"><fieldset id="setup-complete"${disabled}><legend>3. 로그인 완료 주소 입력</legend><p>로그인을 마치면 <code>http://127.0.0.1:1455/auth/callback</code> 주소로 이동합니다. 페이지가 열리지 않는다는 메시지가 보여도 주소 표시줄의 전체 주소를 복사해 아래 칸에 입력하세요.</p><p>이 주소에는 일회용 인증 코드가 있습니다. 이 화면에만 입력하고 채팅이나 메시지로 보내지 마세요. 제출하면 입력 칸이 비워집니다.</p><label for="callback">127.0.0.1 콜백 전체 주소</label><textarea id="callback" rows="4" maxlength="16384" required autocomplete="off" autocapitalize="none" spellcheck="false"></textarea><button id="complete-button" type="submit">연결 완료</button></fieldset></form>${dual ? `<form id="device-start" autocomplete="off"><fieldset id="setup-device"${disabled}><legend>Codex device · 코드로 로그인</legend><p>콜백 주소를 붙여넣지 않고 OpenAI 페이지에서 일회용 코드를 승인합니다. 계정의 디바이스 코드 로그인이 허용되어야 하며, 원격 환경에서 OpenAI가 요청을 거부하면 SIWC를 사용할 수 있습니다.</p><label><input id="device-approval" type="checkbox" required> 모델 요청에 내 ChatGPT 구독을 사용하는 데 동의합니다.</label><button id="device-start-button" type="submit">디바이스 코드 받기</button></fieldset></form>` : ''}<section id="device" hidden><h2>OpenAI에서 코드 승인</h2><p>일회용 코드: <strong id="device-code"></strong></p><p><a id="device-login" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">OpenAI 코드 승인 열기</a></p><p>이 화면을 열어 두세요. 완료되면 연결이 자동으로 전환됩니다.</p></section></main><script nonce="${nonce}">${browserScript(mode)}</script></html>`;
}
