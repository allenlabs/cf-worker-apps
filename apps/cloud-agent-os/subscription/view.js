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
const status = byId('status');
let authenticated = !oidc;
function controls(enabled) {
  authenticated = enabled;
  for (const id of ['setup-start', 'setup-complete']) byId(id).disabled = !enabled;
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
    }
    throw Error(result.error || 'request_failed');
  }
  controls(true);
  byId('sign-in').hidden = true;
  return result;
}
function show(value) {
  status.textContent = value.siwcInferenceReady ? '연결 준비 완료. Cloudflare OS의 모델 연결에서 사용할 수 있습니다.' : value.loginPending ? '로그인 진행 중. 아래 주소 입력 단계를 완료하세요.' : '새 ChatGPT 연결이 필요합니다.';
  byId('identity').textContent = value.identity ? '연결 계정: ' + value.identity.email + ' / 요금제: ' + (value.identity.planType || '확인되지 않음') + ' / 워크스페이스: ' + (value.identity.workspaceName || '이름이 제공되지 않음') + '. 개인 계정이 맞는지 확인하세요.' : '';
}
function failed(error) { status.textContent = '처리하지 못했습니다. 오류 코드: ' + error.message; }
byId('start').addEventListener('submit', async event => {
  event.preventDefault();
  if (!authenticated) return;
  const button = byId('start-button');
  button.disabled = true;
  byId('authorization').hidden = true;
  try {
    const result = await post('start', { email: byId('email').value, planUsageConfirmed: byId('approval').checked });
    byId('login').href = result.authorizationUrl;
    byId('authorization').hidden = false;
    status.textContent = '로그인 링크를 열어 직접 로그인하세요. 연결 시도는 10분 뒤 만료됩니다.';
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
    show(await post('complete', { callbackUrl }));
    byId('login').removeAttribute('href');
    byId('authorization').hidden = true;
  } catch (error) { failed(error); }
  finally { button.disabled = false; }
});
byId('refresh').addEventListener('click', () => post('status', {}).then(show).catch(failed));
post('status', {}).then(show).catch(failed);
`;
}

export function subscriptionPage(nonce, mode = 'access') {
  const disabled = mode === 'oidc' ? ' disabled' : '';
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>ChatGPT 구독 연결</title>
<style nonce="${nonce}">body{font:18px/1.6 system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem;color:#17212b;background:#fafafa}input[type=email],textarea{box-sizing:border-box;width:100%;padding:.7rem;font:inherit}button,a{font:inherit}button{padding:.5rem 1rem;margin:.5rem 0}label{display:block;margin:.7rem 0}fieldset{border:1px solid #b8c2ca;padding:1rem;margin:1rem 0}a{color:#0645ad}#status{padding:1rem;background:#eaf1f8}small{display:block}</style>
<main><h1>개인 ChatGPT 구독 연결</h1><p id="status" role="status" aria-live="polite">연결 상태를 확인하고 있습니다.</p><p id="identity" aria-live="polite"></p><p id="sign-in" hidden><a href="/">OS 로그인</a></p><button id="refresh" type="button">상태 다시 확인</button>
<form id="start" autocomplete="off"><fieldset id="setup-start"${disabled}><legend>1. 계정과 사용 동의</legend><label for="email">로그인할 개인 ChatGPT 이메일</label><input id="email" type="email" maxlength="254" required autocomplete="off" autocapitalize="none" spellcheck="false"><small>처음 지정한 이메일로 고정됩니다. 다음 로그인도 같은 계정을 사용하세요.</small><label><input id="approval" type="checkbox" required> 이 연결을 통한 모델 요청이 내 ChatGPT 구독 사용량을 사용할 수 있음에 동의합니다.</label><button id="start-button" type="submit">새 로그인 시작</button></fieldset></form>
<section id="authorization" hidden><h2>2. 직접 로그인</h2><p><a id="login" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">OpenAI 로그인 열기</a></p><p>위에서 지정한 개인 계정으로 직접 로그인하세요.</p></section>
<form id="complete" autocomplete="off"><fieldset id="setup-complete"${disabled}><legend>3. 로그인 완료 주소 입력</legend><p>로그인을 마치면 <code>http://127.0.0.1:1455/auth/callback</code> 주소로 이동합니다. 페이지가 열리지 않는다는 메시지가 보여도 주소 표시줄의 전체 주소를 복사해 아래 칸에 입력하세요.</p><p>이 주소에는 일회용 인증 코드가 있습니다. 이 화면에만 입력하고 채팅이나 메시지로 보내지 마세요. 제출하면 입력 칸이 비워집니다.</p><label for="callback">127.0.0.1 콜백 전체 주소</label><textarea id="callback" rows="4" maxlength="16384" required autocomplete="off" autocapitalize="none" spellcheck="false"></textarea><button id="complete-button" type="submit">연결 완료</button></fieldset></form></main><script nonce="${nonce}">${browserScript(mode)}</script></html>`;
}
