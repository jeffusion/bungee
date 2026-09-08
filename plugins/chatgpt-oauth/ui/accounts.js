import { control, hostRequest, initializeStyles } from '/__ui/plugin-host-sdk.js';
import { loginStates, accountStates, terminal, verificationUrl, loginStatus, accountSummary, errorText } from './account-model.js';

const $ = id => document.getElementById(id);
let accounts = [], kind = 'device', reauthRef, session = null, status = null, timer, starting = false, submitting = false, cancelling = false, polling = false;
let action = null, actionAccount = null, actionBusy = false;
function notice(id, text, fault = false) {
  const element = $(id); element.textContent = text; element.hidden = !text;
  element.className = `border-l-2 px-3 py-2 text-sm ${fault ? 'border-red-500 bg-red-500/5 text-red-300' : 'border-nexus-500 bg-nexus-500/5 text-zinc-200'}`;
}
function text(tag, content, cls = '') { const node = document.createElement(tag); node.textContent = content; node.className = cls; return node; }
function button(label, handler, cls = 'nx-btn-ghost') { const node = text('button', label, cls); node.type = 'button'; node.onclick = handler; return node; }
async function refreshAccounts() {
  $('refresh').disabled = true;
  try {
    const response = await control('GET', '/accounts');
    if (!Array.isArray(response.accounts)) throw new Error('invalid_response');
    accounts = response.accounts.map(accountSummary); renderAccounts(); notice('notice', '');
  } catch (error) {
    notice('notice', errorText(error), true);
    if (!accounts.length) $('accounts').replaceChildren(text('p', '无法加载账号，点击“刷新”重试。', 'p-5 text-sm text-zinc-400'));
  }
  finally { $('refresh').disabled = false; }
}
function renderAccounts() {
  const container = $('accounts'); container.replaceChildren();
  $('account-count').textContent = `${accounts.filter(account => account.available).length} 可用 / ${accounts.length} 总计`;
  if (!accounts.length) { container.append(text('p', '尚未添加账号。点击“添加账号”开始登录。', 'p-5 text-sm text-zinc-400')); return; }
  for (const account of accounts) {
    const row = document.createElement('article'); row.className = 'account-row'; row.dataset.accountId = account.id;
    const identity = document.createElement('div'); identity.className = 'min-w-0 space-y-2';
    identity.append(text('h3', account.label, 'font-semibold text-sm text-zinc-100 break-all'),
      text('p', account.email ?? '未提供邮箱', 'text-xs text-zinc-400 break-all'), text('p', account.id, 'font-mono text-xs text-zinc-400 break-all'));
    const state = document.createElement('div'); state.className = 'space-y-2';
    state.append(text('span', account.available ? '可用' : accountStates[account.status] === '已启用' ? '需要重新登录' : accountStates[account.status], account.available ? 'nx-badge-active' : 'nx-badge-standby'));
    if (account.plan) state.append(text('p', account.plan, 'text-xs text-zinc-400'));
    if (account.expiresAt) state.append(text('p', `凭据到期：${new Date(account.expiresAt).toLocaleString('zh-CN')}`, 'text-xs text-zinc-400'));
    const actions = document.createElement('div'); actions.className = 'account-actions';
    actions.append(button('影响范围', () => openAction('references', account)));
    if (account.status !== 'revoked') {
      actions.append(button('重命名', () => openAction('rename', account)), button('重新登录', () => openLogin(account.id)),
        button(account.status === 'disabled' ? '启用' : '禁用', () => openAction(account.status === 'disabled' ? 'enable' : 'disable', account)),
        button('移除', () => openAction('delete', account), 'nx-btn-ghost text-red-300'));
    }
    row.append(identity, state, actions); container.append(row);
  }
}
function setKind(value) {
  kind = value;
  for (const mode of ['device', 'pkce']) { $(`method-${mode}`).className = mode === kind ? 'nx-btn-primary' : 'nx-btn-ghost'; $(`method-${mode}`).setAttribute('aria-pressed', String(mode === kind)); }
  $('method-help').textContent = kind === 'device' ? '在验证页面输入设备码，完成后此处会自动更新。' : '备用方式：打开浏览器登录，将最终跳转的完整 localhost 回调地址粘贴到此处。';
  $('start-login').textContent = kind === 'device' ? '开始设备码登录' : '开始浏览器登录';
}
function openLogin(accountRef) {
  if (session && !terminal(status?.state)) {
    $('login-dialog').showModal();
    if (reauthRef !== accountRef) notice('login-notice', '已有登录会话进行中，请先完成或取消当前会话。');
    return;
  }
  clearTimeout(timer); session = null; status = null; reauthRef = accountRef; starting = false;
  $('callback-url').value = ''; notice('login-notice', ''); setKind('device');
  $('login-title').textContent = accountRef ? `重新登录 · ${accounts.find(account => account.id === accountRef)?.label ?? accountRef}` : '添加账号'; renderSession(); $('login-dialog').showModal();
}
function renderSession() {
  const state = status?.state, done = terminal(state), active = !!session && !done;
  $('session-content').hidden = !session;
  $('login-methods').hidden = active || starting;
  $('start-login').hidden = active; $('start-login').disabled = starting;
  $('cancel-login').hidden = !active; $('cancel-login').disabled = cancelling || state === 'committing';
  $('retry-status').hidden = !session; $('new-service').hidden = state !== 'success';
  $('close-login').disabled = starting;
  if (!session) return;
  $('login-state').textContent = state ? loginStates[state] : '正在查询登录状态';
  $('login-state').className = state === 'success' ? 'nx-badge-active' : ['failed', 'expired'].includes(state) ? 'nx-badge-fault' : 'nx-badge-standby';
  $('login-expiry').textContent = `有效期至 ${new Date(session.expiresAt).toLocaleTimeString('zh-CN')}`;
  $('device-code-panel').hidden = kind !== 'device' || done;
  $('device-code').textContent = done ? '' : session.userCode ?? '';
  const url = done ? null : verificationUrl(session.verificationUri ?? session.authorizationUrl, kind);
  $('verification-panel').hidden = !url; $('verification-url').value = url ?? '';
  $('verification-link').href = url ?? '#';
  $('callback-form').hidden = kind !== 'pkce' || state !== 'pending';
  $('submit-callback').disabled = submitting;
  $('login-result').textContent = state === 'committing' ? '账号正在保存，无法保证取消。请等待最终结果，不要重复登录。'
    : state === 'success' ? '账号已登录。服务尚未创建或发布，请到服务编辑器选择该账号并保存配置。'
    : state === 'failed' ? '登录失败，请重新开始。' : state === 'cancelled' ? '登录已取消。' : state === 'expired' ? '本次登录已过期，请重新开始。' : '关闭窗口不会取消登录；需要停止时请点击“取消登录”。';
  if (done) { $('callback-url').value = ''; session.authorizationUrl = undefined; session.verificationUri = undefined; session.userCode = undefined; }
}
async function pollStatus() {
  if (polling) return;
  clearTimeout(timer);
  const current = session;
  if (!current) return;
  polling = true;
  try {
    const next = loginStatus(await control('GET', `/login/status?sessionId=${encodeURIComponent(current.sessionId)}`), current.sessionId);
    if (session !== current) return;
    const firstSuccess = status?.state !== 'success' && next.state === 'success';
    if (status?.state !== next.state) notice('login-notice', '');
    status = next; renderSession();
    if (firstSuccess) await refreshAccounts();
  } catch (error) {
    if (session === current) {
      if (['not_found', 'expired'].includes(error.message)) { session = null; status = null; renderSession(); }
      notice('login-notice', errorText(error), true);
    }
  }
  finally { polling = false; }
  if (session === current && !terminal(status?.state)) timer = setTimeout(pollStatus, 2000);
}
async function startLogin() {
  if (starting || (session && !terminal(status?.state))) return;
  starting = true; notice('login-notice', '正在创建登录会话…'); renderSession();
  try {
    const started = await control('POST', `/login/${kind}`, reauthRef ? { accountRef: reauthRef } : {});
    if (!started || typeof started.sessionId !== 'string' || !started.sessionId || started.sessionId.length > 128 || !Number.isFinite(started.expiresAt)
      || (kind === 'device' && (typeof started.userCode !== 'string' || !started.userCode))
      || !verificationUrl(started.verificationUri ?? started.authorizationUrl, kind)) throw new Error('invalid_response');
    session = started; status = null; await pollStatus();
  } catch (error) { notice('login-notice', errorText(error), true); }
  finally { starting = false; renderSession(); }
}
async function cancelLogin() {
  if (!session || terminal(status?.state) || status?.state === 'committing' || cancelling) return;
  cancelling = true; $('callback-url').value = ''; renderSession();
  try {
    const response = await control('POST', '/login/cancel', { sessionId: session.sessionId });
    await pollStatus();
    if (response.cancelled !== true && !terminal(status?.state)) notice('login-notice', '取消未确认，操作可能已进入保存阶段。请等待最终状态。');
  } catch (error) { notice('login-notice', errorText(error), true); }
  finally { cancelling = false; renderSession(); }
}
async function submitCallback(event) {
  event.preventDefault();
  if (!session || submitting || status?.state !== 'pending') return;
  let callbackUrl = $('callback-url').value.trim(); $('callback-url').value = '';
  if (!callbackUrl) return;
  submitting = true; renderSession();
  try {
    const request = control('POST', '/login/callback', { sessionId: session.sessionId, callbackUrl });
    callbackUrl = ''; // Never keep callback material in UI state or browser storage.
    await request; await pollStatus();
  } catch (error) { await pollStatus(); notice('login-notice', errorText(error), true); }
  finally { callbackUrl = ''; submitting = false; renderSession(); }
}
async function copy(value) {
  try { await navigator.clipboard.writeText(value); notice('login-notice', '已复制。'); }
  catch { notice('login-notice', '无法访问剪贴板，请选中内容后手动复制。'); }
}
async function openAction(value, account) {
  action = value; actionAccount = account; actionBusy = false;
  const names = { rename: '重命名账号', disable: '禁用账号', enable: '启用账号', delete: '移除账号', references: '账号影响范围' };
  $('action-title').textContent = names[value]; $('action-account').textContent = `${account.label} · ${account.id}`;
  $('rename-field').hidden = value !== 'rename'; $('account-label').value = account.label;
  $('confirm-action').hidden = value === 'references'; $('confirm-action').disabled = false; $('cancel-action').disabled = false;
  $('confirm-action').textContent = value === 'delete' ? '确认移除' : '确认';
  $('action-warning').textContent = ['delete', 'disable'].includes(value) ? '此操作会使引用该账号的上游不可用，不会自动删除服务或路由配置。即使存在引用，仍可确认继续。' : '';
  $('reference-summary').replaceChildren(); notice('action-notice', ''); $('action-dialog').showModal();
  if (value === 'rename') { $('account-label').focus(); return; }
  $('reference-summary').textContent = '正在查询当前配置引用…';
  try {
    const refs = await hostRequest('references', { accountRef: account.id });
    if (actionAccount !== account || action !== value) return;
    const container = $('reference-summary'); container.replaceChildren();
    container.append(text('p', `当前配置版本 ${refs.revision}：${refs.services.length} 个服务，${refs.routes.length} 条路由。`));
    if (refs.global) container.append(text('p', '全局插件配置也存在账号引用。', 'text-amber-300'));
    if (refs.services.length) container.append(text('p', `服务：${refs.services.map(item => item.name).join('、')}`, 'break-all'));
    if (refs.routes.length) container.append(text('p', `路由：${refs.routes.map(item => item.path).join('、')}`, 'break-all'));
    container.append(text('p', '仅表示当前配置引用，运行时使用情况未知。', 'text-xs text-zinc-400'));
  } catch { $('reference-summary').textContent = '引用查询失败，无法确认当前配置影响；运行时使用情况未知。'; }
}
async function confirmAction(event) {
  event.preventDefault(); if (!actionAccount || actionBusy || action === 'references') return;
  const label = $('account-label').value.trim();
  if (action === 'rename' && !label) { notice('action-notice', '请输入账号名称。', true); return; }
  actionBusy = true; $('confirm-action').disabled = true; $('cancel-action').disabled = true;
  try {
    await control('POST', `/accounts/${action}`, { accountRef: actionAccount.id, ...(action === 'rename' ? { label } : {}) });
    $('action-dialog').close(); await refreshAccounts();
  } catch (error) { notice('action-notice', errorText(error), true); }
  finally { actionBusy = false; $('confirm-action').disabled = false; $('cancel-action').disabled = false; }
}
$('refresh').onclick = refreshAccounts; $('new-account').onclick = () => openLogin();
$('method-device').onclick = () => setKind('device'); $('method-pkce').onclick = () => setKind('pkce');
$('start-login').onclick = startLogin; $('retry-status').onclick = pollStatus; $('cancel-login').onclick = cancelLogin;
$('submit-callback').onclick = submitCallback;
$('callback-url').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); void submitCallback(event); } };
$('copy-code').onclick = () => copy(session?.userCode ?? ''); $('copy-verification').onclick = () => copy($('verification-url').value);
$('open-verification').onclick = async () => {
  const url = verificationUrl($('verification-url').value, kind);
  if (!url) return;
  try { await hostRequest('open-external', { url }); notice('login-notice', '请在宿主页面顶部核对地址并确认打开。'); }
  catch { notice('login-notice', '无法请求宿主打开页面，请复制地址自行打开。'); }
};
$('close-login').onclick = () => { $('callback-url').value = ''; $('login-dialog').close(); };
$('login-dialog').addEventListener('cancel', event => { if (starting) event.preventDefault(); $('callback-url').value = ''; });
$('new-service').onclick = () => hostRequest('new-service').catch(error => notice('login-notice', errorText(error), true));
$('cancel-action').onclick = () => { if (!actionBusy) $('action-dialog').close(); };
$('action-dialog').addEventListener('cancel', event => { if (actionBusy) event.preventDefault(); });
$('confirm-action').onclick = confirmAction;
$('account-label').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); void confirmAction(event); } };
window.addEventListener('pagehide', () => { clearTimeout(timer); $('callback-url').value = ''; session = null; });
try { await initializeStyles(); await refreshAccounts(); }
catch { notice('notice', '宿主连接不可用，请从 Bungee 插件设置页重新打开。', true); }
