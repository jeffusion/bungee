/**
 * 自动生成的原生组件注册表
 *
 * 此文件由 scripts/generate-widget-registry.ts 自动生成，请勿手动修改。
 */

import type { ComponentType, SvelteComponent } from 'svelte';

import ChatgptAccountsPage from '@plugins/chatgpt-oauth/ui/AccountsPage.svelte';
import ChatgptQuotaWidget from '@plugins/chatgpt-oauth/ui/ChatgptQuotaWidget.svelte';
import KeyAccessKeyPolicy from '@plugins/key-access/ui/KeyPolicy.svelte';
import KeyRateLimitKeyPolicy from '@plugins/key-rate-limit/ui/KeyPolicy.svelte';
import LocalAccountsSettings from '@plugins/local-accounts/ui/Settings.svelte';
import LocalAccountsLogin from '@plugins/local-accounts/ui/Login.svelte';
import ModelsDevSettings from '@plugins/models-dev/ui/ModelsDevSettings.svelte';
import TokenBudgetKeyPolicy from '@plugins/token-budget/ui/KeyPolicy.svelte';
import TokenStatsChart from '@plugins/token-stats/ui/TokenStatsChart.svelte';
import TokenStatsSettings from '@plugins/token-stats/ui/TokenStatsSettings.svelte';
import TokenStatsMetric from '@plugins/token-stats/ui/TokenStatsMetric.svelte';
import TokenStatsPage from '@plugins/token-stats/ui/TokenStatsPage.svelte';

export const generatedWidgetRegistry: Record<string, ComponentType<SvelteComponent>> = {
  ChatgptAccountsPage,
  ChatgptQuotaWidget,
  KeyAccessKeyPolicy,
  KeyRateLimitKeyPolicy,
  LocalAccountsSettings,
  LocalAccountsLogin,
  ModelsDevSettings,
  TokenBudgetKeyPolicy,
  TokenStatsChart,
  TokenStatsSettings,
  TokenStatsMetric,
  TokenStatsPage,
};

export const componentSourceMap: Record<string, string> = {
  ChatgptAccountsPage: 'chatgpt-oauth',
  ChatgptQuotaWidget: 'chatgpt-oauth',
  KeyAccessKeyPolicy: 'key-access',
  KeyRateLimitKeyPolicy: 'key-rate-limit',
  LocalAccountsSettings: 'local-accounts',
  LocalAccountsLogin: 'local-accounts',
  ModelsDevSettings: 'models-dev',
  TokenBudgetKeyPolicy: 'token-budget',
  TokenStatsChart: 'token-stats',
  TokenStatsSettings: 'token-stats',
  TokenStatsMetric: 'token-stats',
  TokenStatsPage: 'token-stats',
};

export const generatedPluginTranslations = {
  "zh-CN": {
    "plugins": {
      "local-accounts": {
        "metadata.name": "管理认证",
        "metadata.description": "可选的单管理员账号密码认证",
        "login.title": "账号登录",
        "login.description": "使用管理认证插件中设置的唯一管理员账号。",
        "login.username": "账号",
        "login.password": "密码",
        "login.busy": "正在建立登录会话…",
        "login.submit": "登录",
        "login.technicalDetails": "技术详情",
        "login.correctAddress": "使用正确地址：{origin}",
        "login.errors.invalid_credentials": "账号或密码不正确。请重新输入。",
        "login.errors.invalid_input": "账号格式不正确。账号名只允许字母、数字及 _ . @ -，长度为 1–64。",
        "login.errors.forbidden": "当前登录请求无法完成。请刷新后重试。",
        "login.errors.unauthorized": "登录会话未建立。请重新登录。",
        "login.errors.invalid_origin": "当前访问地址与服务配置不匹配。请使用配置的公开地址登录，或请部署管理员调整公开地址。",
        "login.errors.invalid_csrf": "当前会话或访问地址校验失败。请从配置的公开地址重新登录。",
        "login.errors.login_limited": "登录尝试过多。请等待 15 分钟后重试。",
        "login.errors.session_limit": "登录会话已达到上限。请退出不再使用的会话后重试。",
        "login.errors.management_provider_unavailable": "账号服务暂时不可用。请检查服务状态，恢复后重试。",
        "login.errors.provider_unavailable": "账号服务暂时不可用。请检查服务状态，恢复后重试。",
        "login.errors.control_recovering": "账号服务正在恢复。请稍候重试。",
        "login.errors.session_unavailable": "登录尚未完成。请检查连接后重试，或刷新管理访问状态。",
        "login.errors.unknown": "登录未完成。请检查连接后重试。",
        "recovery.summary": "忘记账号或密码？",
        "recovery.intro": "请在部署服务器上恢复，网页不能直接重置管理员。",
        "recovery.step1": "确认目标实例的配置数据库路径，停止该实例的全部进程并备份数据。",
        "recovery.step2": "在原部署目录、使用原环境变量执行下面的命令，将数据库路径替换为实际绝对路径。",
        "recovery.step3": "按提示输入新的账号和密码，然后重新启动实例。旧会话会失效，路由、服务及 API Key 保留。",
        "recovery.docker": "Docker 部署：停止原容器后，使用同一镜像、原数据卷及环境变量启动临时交互容器，执行同一命令；完成后删除临时容器并启动原容器。请勿另建空数据卷。",
        "recovery.note": "密码交互输入且不显示。若提示恢复失败，请确认实例已完全停止、路径及环境正确；旧版本存在多个管理员时需由部署人员处理。",
        "settings.accountTitle": "管理员账号",
        "settings.accountTag": "账号",
        "settings.passwordTag": "密码",
        "settings.loading": "正在读取管理员账号",
        "settings.accountDescription": "管理认证使用此唯一管理员账号。停用插件后恢复匿名管理访问。",
        "settings.passwordTitle": "修改登录密码",
        "settings.passwordDescription": "修改后当前登录会话失效，需要重新登录。",
        "settings.currentPassword": "当前密码",
        "settings.newPassword": "新密码（6–64 个字符）",
        "settings.confirmation": "确认新密码",
        "settings.updating": "正在更新…",
        "settings.submit": "修改并重新登录",
        "settings.logout": "退出当前会话",
        "session.title": "登录会话",
        "session.tag": "有效期",
        "session.description": "保存后仅影响新登录的会话，已有会话保留登录时的设置。时长设为 0 可关闭对应超时。",
        "session.idle": "空闲超时",
        "session.absolute": "登录最长有效期",
        "session.minutes": "分钟",
        "session.hours": "小时",
        "session.days": "天",
        "session.unit": "时长单位",
        "session.browserNote": "关闭超时不影响退出登录、改密和身份恢复时撤销会话。浏览器仍可能清理 Cookie；正常核验会话时会续期 Cookie，但不会延长登录最长有效期。",
        "session.loading": "正在读取会话设置",
        "session.save": "保存会话设置",
        "session.saving": "正在保存…",
        "session.saved": "已保存，下次登录生效。",
        "session.invalid": "请输入非负整数时长；0 表示关闭超时。",
        "session.conflict": "设置已被其他页面修改。请重新读取后再保存。",
        "session.failed": "会话设置读取或保存失败。",
        "session.reload": "重新读取"
      }
    }
  },
  "en": {
    "plugins": {
      "local-accounts": {
        "metadata.name": "Management authentication",
        "metadata.description": "Optional username and password authentication for a single administrator",
        "login.title": "Account sign-in",
        "login.description": "Use the sole administrator account configured in the management authentication plugin.",
        "login.username": "Username",
        "login.password": "Password",
        "login.busy": "Establishing a sign-in session…",
        "login.submit": "Sign in",
        "login.technicalDetails": "Technical details",
        "login.correctAddress": "Use the correct address: {origin}",
        "login.errors.invalid_credentials": "Incorrect username or password. Enter your credentials again.",
        "login.errors.invalid_input": "Invalid username. Use 1–64 characters containing letters, numbers, and _ . @ - only.",
        "login.errors.forbidden": "This sign-in request could not be completed. Refresh and try again.",
        "login.errors.unauthorized": "A sign-in session was not established. Sign in again.",
        "login.errors.invalid_origin": "This address does not match the service configuration. Sign in at the configured public address, or ask the deployment administrator to update it.",
        "login.errors.invalid_csrf": "Session or address verification failed. Sign in again at the configured public address.",
        "login.errors.login_limited": "Too many sign-in attempts. Wait 15 minutes before trying again.",
        "login.errors.session_limit": "The sign-in session limit has been reached. Sign out of unused sessions and try again.",
        "login.errors.management_provider_unavailable": "The account service is temporarily unavailable. Check its status and try again after recovery.",
        "login.errors.provider_unavailable": "The account service is temporarily unavailable. Check its status and try again after recovery.",
        "login.errors.control_recovering": "The account service is recovering. Try again shortly.",
        "login.errors.session_unavailable": "Sign-in has not completed. Check your connection and retry, or refresh management access status.",
        "login.errors.unknown": "Sign-in did not complete. Check your connection and try again.",
        "recovery.summary": "Forgot your username or password?",
        "recovery.intro": "Recover access on the deployment server. The web page cannot reset the administrator directly.",
        "recovery.step1": "Confirm the target instance’s configuration database path, stop all its processes, and back up the data.",
        "recovery.step2": "Run the following command from the original deployment directory with the original environment variables. Replace the database path with its actual absolute path.",
        "recovery.step3": "Enter a new username and password when prompted, then restart the instance. Old sessions will expire; routes, services, and API Keys will be retained.",
        "recovery.docker": "For Docker deployments, stop the original container, start a temporary interactive container with the same image, original data volume, and environment variables, and run the same command. Afterwards, remove the temporary container and restart the original one. Do not create an empty data volume.",
        "recovery.note": "Passwords are entered interactively and remain hidden. If recovery fails, confirm the instance is fully stopped and the path and environment are correct. Deployment staff must handle older versions with multiple administrators.",
        "settings.accountTitle": "Administrator account",
        "settings.accountTag": "Account",
        "settings.passwordTag": "Password",
        "settings.loading": "Loading administrator account",
        "settings.accountDescription": "Management authentication uses this sole administrator account. Disabling the plugin restores anonymous management access.",
        "settings.passwordTitle": "Change sign-in password",
        "settings.passwordDescription": "Changing the password invalidates the current session. Sign in again afterwards.",
        "settings.currentPassword": "Current password",
        "settings.newPassword": "New password (6–64 characters)",
        "settings.confirmation": "Confirm new password",
        "settings.updating": "Updating…",
        "settings.submit": "Change and sign in again",
        "settings.logout": "Sign out of current session",
        "session.title": "Sign-in sessions",
        "session.tag": "LIFETIME",
        "session.description": "Saved settings apply only to new sign-ins. Existing sessions retain their original settings. Set a duration to 0 to disable that timeout.",
        "session.idle": "Idle timeout",
        "session.absolute": "Maximum sign-in lifetime",
        "session.minutes": "Minutes",
        "session.hours": "Hours",
        "session.days": "Days",
        "session.unit": "Duration unit",
        "session.browserNote": "Disabling timeouts does not prevent sign-out, password changes or identity recovery from revoking sessions. Browsers may still clear cookies. Session verification renews the cookie without extending the maximum sign-in lifetime.",
        "session.loading": "Loading session settings",
        "session.save": "Save session settings",
        "session.saving": "Saving…",
        "session.saved": "Saved. Applies to your next sign-in.",
        "session.invalid": "Enter a non-negative whole-number duration. 0 disables the timeout.",
        "session.conflict": "Another page changed these settings. Reload before saving.",
        "session.failed": "Could not read or save session settings.",
        "session.reload": "Reload settings"
      }
    }
  }
} as const;
