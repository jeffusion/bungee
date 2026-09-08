export const loginStates = Object.freeze({ pending: '等待登录', polling: '等待设备授权', exchanging: '正在交换授权', committing: '正在保存账号', success: '账号已登录', failed: '登录失败', cancelled: '已取消登录', expired: '登录已过期' });
export const accountStates = Object.freeze({ active: '已启用', disabled: '已禁用', revoked: '已移除', reauth_required: '需要重新登录' });
/** @param {unknown} state */
export const terminal = state => typeof state === 'string' && ['success', 'failed', 'cancelled', 'expired'].includes(state);
/** @param {unknown} value @param {string} kind */
export function verificationUrl(value, kind) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const path = kind === 'device' ? '/codex/device' : '/oauth/authorize';
    if (url.origin !== 'https://auth.openai.com' || url.pathname !== path || url.username || url.password || url.hash) return null;
    return url.href;
  } catch { return null; }
}
/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_response');
  return /** @type {Record<string, unknown>} */ (value);
}
/** @param {unknown} input @param {string} sessionId */
export function loginStatus(input, sessionId) {
  const value = record(input);
  if (value.sessionId !== sessionId || typeof value.state !== 'string' || !Object.hasOwn(loginStates, value.state)
    || typeof value.kind !== 'string' || !['device', 'pkce'].includes(value.kind) || !Number.isFinite(value.expiresAt)) throw new Error('invalid_response');
  return value;
}
/** @param {unknown} input */
export function accountSummary(input) {
  const value = record(input);
  if (typeof value.id !== 'string' || typeof value.label !== 'string' || typeof value.status !== 'string' || !Object.hasOwn(accountStates, value.status)
    || typeof value.available !== 'boolean') throw new Error('invalid_response');
  const identity = value.identity === undefined ? {} : record(value.identity);
  return { id: value.id, label: value.label, status: value.status, available: value.available,
    expiresAt: Number.isFinite(value.expiresAt) ? value.expiresAt : undefined,
    email: typeof identity.email === 'string' ? identity.email : undefined,
    plan: typeof identity.planType === 'string' ? identity.planType : undefined };
}
/** @type {Record<string, string>} */
const messages = {
  invalid_input: '输入内容无效，请检查后重试。', invalid_response: '服务器返回格式无效，请刷新重试。',
  not_found: '账号或登录会话已不存在，请刷新后重试。', expired: '登录会话已过期，请重新开始。',
  cancelled: '登录已取消。', busy: '操作正在进行，请刷新登录状态。', login_failed: '登录失败，请重新开始。',
  disabled: '账号已禁用，请先启用。', revoked: '账号已移除。', reauth_required: '账号需要重新登录。',
  identity_mismatch: '登录身份与原账号不一致，请使用原账号重新登录。', invalid_identity: '无法验证账号身份，请重新登录。',
  disposed: '插件当前不可用，请稍后重试。', version_conflict: '账号已被其他操作修改，请刷新后重试。',
};
/** @param {unknown} error */
export const errorText = error => (error instanceof Error ? messages[error.message] : undefined) ?? '操作未完成，请刷新状态后重试。请勿重复提交授权。';
