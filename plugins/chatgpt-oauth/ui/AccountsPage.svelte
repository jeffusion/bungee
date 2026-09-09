<script lang="ts">
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { requestPluginControl } from '$api/client';
  import { getConfigSnapshot } from '$api/config';
  import { ServicesAPI, type Service } from '$api/services';
  import { accountReferences } from '$api/upstream-sources';
  import { sourceHandoffUrl } from '$api/source-handoff';
  import { StatusBadge, LoadingIndicator, IndustrialDialog } from '$components/industrial';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import Plus from 'lucide-svelte/icons/plus';
  import Server from 'lucide-svelte/icons/server';
  import Ellipsis from 'lucide-svelte/icons/ellipsis';
  import Pencil from 'lucide-svelte/icons/pencil';
  import LogIn from 'lucide-svelte/icons/log-in';
  import Power from 'lucide-svelte/icons/power';
  import PowerOff from 'lucide-svelte/icons/power-off';
  import Trash2 from 'lucide-svelte/icons/trash-2';
  import Link2 from 'lucide-svelte/icons/link-2';
  import Copy from 'lucide-svelte/icons/copy';
  import ExternalLink from 'lucide-svelte/icons/external-link';
  import Send from 'lucide-svelte/icons/send';
  import X from 'lucide-svelte/icons/x';
  import ArrowRight from 'lucide-svelte/icons/arrow-right';
  import Check from 'lucide-svelte/icons/check';
  import * as Select from '$components/ui/select';
  import * as RadioGroup from '$components/ui/radio-group';
  import { _, locale } from '$i18n';
  import { isLoading } from 'svelte-i18n';
  import { getPluginText } from '$utils/plugin-i18n';
  import { Button } from '$components/ui/button';
  import { Input } from '$components/ui/input';
  import * as DropdownMenu from '$components/ui/dropdown-menu';
  import { loginStates, accountStates, terminal, verificationUrl, loginStatus, parseLoginStart, accountSummary, errorText, errorCode } from './account-model.js';

  type Account = ReturnType<typeof accountSummary>;
  type Session = { sessionId: string; expiresAt: number; userCode?: string; verificationUri?: string; authorizationUrl?: string };
  const pluginName = 'chatgpt-oauth';
  const id = $props.id();
  const t = (key: string, values: Record<string, string | number> = {}) => $isLoading ? '' : getPluginText(key, pluginName, (key, options) => $_(key, { ...options, values }));
  const dateText = (value: number) => new Date(value).toLocaleString($locale ?? 'en');
  const lifetime = new AbortController();
  const control = <T,>(method: 'GET' | 'POST', path: string, body?: unknown) => requestPluginControl<T>(pluginName, path, method, body, lifetime.signal);
  let accounts = $state<Account[]>([]), refreshing = $state(false), notice = $state('');
  let loginOpen = $state(false), kind = $state('device'), reauthRef = $state<string | undefined>();
  let session = $state.raw<Session | null>(null), status = $state(''), callback = $state(''), loginNotice = $state('');
  let starting = $state(false), submitting = $state(false), cancelling = $state(false), polling = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = $derived(session !== null && !terminal(status));
  let url = $derived(active ? verificationUrl(session?.verificationUri ?? session?.authorizationUrl, kind) : null);
  let action = $state(''), actionAccount = $state<Account | null>(null), actionOpen = $state(false);
  let actionBusy = $state(false), label = $state(''), actionNotice = $state(''), referenceNotice = $state('');
  let references = $state<(ReturnType<typeof accountReferences> & { revision: number }) | null>(null);
  let referenceGeneration = 0;
  const actionTitles: Record<string, string> = { rename: 'ui.renameTitle', disable: 'ui.disableTitle', enable: 'ui.enableTitle', delete: 'ui.deleteTitle', references: 'ui.referencesTitle' };
  const actionIcons: Record<string, typeof Check> = { rename: Pencil, disable: PowerOff, enable: Power, delete: Trash2, references: Link2 };
  let useOpen = $state(false), useAccount = $state<Account | null>(null), services = $state<Service[]>([]);
  let serviceChoice = $state('new'), servicesLoading = $state(false), serviceError = $state('');
  let selectedService = $derived($isLoading ? undefined : { value: serviceChoice, label: serviceChoice === 'new' ? t('ui.newService') : services.find(service => service._uid === serviceChoice)?.name ?? serviceChoice });

  async function refreshAccounts() {
    if (refreshing) return;
    refreshing = true; notice = '';
    try {
      const response = await control<{ accounts: unknown[] }>('GET', '/accounts');
      if (!Array.isArray(response.accounts)) throw new Error('invalid_response');
      accounts = response.accounts.map(accountSummary);
    } catch (error) { if (!lifetime.signal.aborted) notice = errorText(error); }
    finally { refreshing = false; }
  }
  function openLogin(accountRef?: string) {
    loginOpen = true;
    // Read the session itself; a derived value may not have flushed after a close/open event.
    if ((session !== null && !terminal(status)) || starting) {
      if (reauthRef !== accountRef) loginNotice = 'ui.otherSession';
      return;
    }
    clearTimeout(timer); session = null; status = ''; callback = ''; loginNotice = ''; kind = 'device'; reauthRef = accountRef;
  }
  function clearSecrets() {
    callback = '';
    if (session) session = { sessionId: session.sessionId, expiresAt: session.expiresAt };
  }
  async function pollStatus() {
    if (polling || !session) return;
    clearTimeout(timer); const current = session.sessionId; polling = true;
    try {
      const next = loginStatus(await control('GET', `/login/status?sessionId=${encodeURIComponent(current)}`), current);
      if (session?.sessionId !== current || lifetime.signal.aborted) return;
      const firstSuccess = status !== 'success' && next.state === 'success';
      status = String(next.state); loginNotice = '';
      if (terminal(status)) clearSecrets();
      if (firstSuccess) await refreshAccounts();
    } catch (error) {
      if (!lifetime.signal.aborted && session?.sessionId === current) {
        loginNotice = errorText(error);
        if (['not_found', 'expired'].includes(errorCode(error))) { clearTimeout(timer); clearSecrets(); session = null; status = ''; }
      }
    } finally { polling = false; }
    if (!lifetime.signal.aborted && session?.sessionId === current && !terminal(status)) timer = setTimeout(pollStatus, 2000);
  }
  async function startLogin() {
    if (starting || (session !== null && !terminal(status))) return;
    starting = true; loginNotice = '';
    try {
      const started = parseLoginStart(await control('POST', `/login/${kind}`, reauthRef ? { accountRef: reauthRef } : {}), kind);
      if (lifetime.signal.aborted) return;
      session = started; status = ''; await pollStatus();
    } catch (error) { if (!lifetime.signal.aborted) loginNotice = errorText(error); }
    finally { starting = false; }
  }
  async function cancelLogin() {
    if (!session || !active || status === 'committing' || cancelling) return;
    cancelling = true; callback = '';
    try {
      const response = await control<{ cancelled: boolean }>('POST', '/login/cancel', { sessionId: session.sessionId });
      await pollStatus();
      if (!response.cancelled && session && !terminal(status)) loginNotice = 'ui.cancelUnconfirmed';
    } catch (error) { loginNotice = errorText(error); }
    finally { cancelling = false; }
  }
  async function submitCallback(event: SubmitEvent) {
    event.preventDefault();
    if (!session || submitting || status !== 'pending') return;
    let callbackUrl = callback.trim(); callback = '';
    if (!callbackUrl) return;
    submitting = true;
    try {
      const request = control('POST', '/login/callback', { sessionId: session.sessionId, callbackUrl });
      callbackUrl = ''; // Never persist callback material in storage, navigation, or service drafts.
      await request; await pollStatus();
    } catch (error) { await pollStatus(); loginNotice = errorText(error); }
    finally { callbackUrl = ''; submitting = false; }
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); loginNotice = 'ui.copied'; }
    catch { loginNotice = 'ui.copyFailed'; }
  }
  async function openAction(value: string, account: Account) {
    if (actionBusy) return;
    const generation = ++referenceGeneration;
    action = value; actionAccount = account; label = account.label; actionNotice = ''; references = null; referenceNotice = ''; actionOpen = true;
    if (value === 'rename') return;
    referenceNotice = 'ui.referencesLoading';
    try {
      const snapshot = await getConfigSnapshot();
      const refs = accountReferences(snapshot.config.logical_configuration, pluginName, account.id);
      if (generation !== referenceGeneration) return;
      references = { ...refs, revision: snapshot.revision }; referenceNotice = '';
    } catch { if (generation === referenceGeneration) referenceNotice = 'ui.referencesFailed'; }
  }
  async function confirmAction(event: SubmitEvent) {
    event.preventDefault();
    if (!actionAccount || actionBusy || action === 'references') return;
    if (action === 'rename' && !label.trim()) { actionNotice = 'ui.nameRequired'; return; }
    actionBusy = true;
    const generation = referenceGeneration;
    try {
      await control('POST', `/accounts/${action}`, { accountRef: actionAccount.id, ...(action === 'rename' ? { label: label.trim() } : {}) });
      if (generation === referenceGeneration) actionOpen = false;
      await refreshAccounts();
    } catch (error) { actionNotice = errorText(error); }
    finally { actionBusy = false; }
  }
  async function loadServices() {
    servicesLoading = true; serviceError = '';
    try { services = await ServicesAPI.list(); }
    catch { serviceError = 'ui.servicesFailed'; }
    finally { servicesLoading = false; }
  }
  function openUse(account: Account) {
    if (!account.available) return;
    useAccount = account; serviceChoice = 'new'; services = []; useOpen = true; void loadServices();
  }
  function continueToService() {
    if (!useAccount?.available || servicesLoading || serviceError) return;
    const existing = services.find(service => service._uid === serviceChoice);
    if (serviceChoice !== 'new' && !existing) { serviceError = 'ui.serviceMissing'; return; }
    const handoff = { sourcePlugin: pluginName, sourceId: 'chatgpt', accountRef: useAccount.id,
      mode: existing ? 'existing' as const : 'new' as const, ...(existing ? { serviceId: existing._uid } : {}) };
    useOpen = false; loginOpen = false; clearSecrets();
    void push(sourceHandoffUrl(handoff, existing?.name));
  }
  function clearSession() { clearTimeout(timer); clearSecrets(); session = null; status = ''; }
  onMount(() => { void refreshAccounts(); return () => { lifetime.abort(); clearSession(); }; });
</script>

<svelte:window onpagehide={clearSession} />

{#snippet actionIcon(Icon: typeof Check, busy = false)}
  <span class="mr-2 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
    {#if busy}<LoadingIndicator size="xs" centered={false} label="" />{:else}<Icon class="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />{/if}
  </span>
{/snippet}

<div class="p-3 sm:p-4 space-y-3" data-testid="chatgpt-accounts-page">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <p class="text-sm text-zinc-400">{t('ui.accountCount', { available: accounts.filter(account => account.available).length, total: accounts.length })}</p>
    <div class="flex gap-2"><Button variant="outline" disabled={refreshing} aria-busy={refreshing} onclick={refreshAccounts}>{@render actionIcon(RefreshCw, refreshing)}{t('ui.refresh')}</Button><Button onclick={() => openLogin()}>{@render actionIcon(Plus)}{t('ui.addAccount')}</Button></div>
  </div>
  {#if notice}<p role="alert" class="text-sm text-red-300">{t(notice)}</p>{/if}
  {#if refreshing && !accounts.length}<LoadingIndicator label={t('ui.accountsLoading')} height="sm" />
  {:else if !accounts.length}<p class="py-6 text-sm text-zinc-400">{t(notice ? 'ui.accountsFailed' : 'ui.noAccounts')}</p>
  {:else}
    <div class="divide-y divide-carbon-600">
      {#each accounts as account (account.id)}
        <article class="grid grid-cols-1 gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto]" data-account-id={account.id}>
          <div class="min-w-0 space-y-1.5">
            <div class="flex flex-wrap items-center gap-2"><h2 class="font-semibold text-sm text-zinc-100 break-all">{account.label}</h2><StatusBadge variant={account.available ? 'active' : account.status === 'revoked' ? 'muted' : 'standby'}>{t(account.available ? 'ui.available' : account.status === 'active' ? 'account.reauth_required' : accountStates[account.status as keyof typeof accountStates])}</StatusBadge></div>
            <p class="text-sm text-zinc-400 break-all">{account.email ?? t('ui.noEmail')}{account.plan ? ` · ${account.plan}` : ''}</p>
            <p class="font-mono text-xs text-zinc-500 break-all">{account.id}</p>
            {#if typeof account.expiresAt === 'number'}<p class="text-sm text-zinc-400">{t('ui.credentialExpiry', { date: dateText(account.expiresAt) })}</p>{/if}
          </div>
          <div class="flex items-start gap-2">
            <Button disabled={!account.available} onclick={() => openUse(account)}>{@render actionIcon(Server)}{t('ui.useService')}</Button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild let:builder><Button variant="ghost" builders={[builder]} disabled={actionBusy}>{@render actionIcon(Ellipsis)}{t('ui.more')}<span class="sr-only">: {account.label}</span></Button></DropdownMenu.Trigger>
              <DropdownMenu.Content class="z-[200]" align="end">
              <DropdownMenu.Item onclick={() => openAction('references', account)}>{@render actionIcon(Link2)}{t('ui.referencesTitle')}</DropdownMenu.Item>
              {#if account.status !== 'revoked'}
                <DropdownMenu.Item onclick={() => openAction('rename', account)}>{@render actionIcon(Pencil)}{t('ui.renameTitle')}</DropdownMenu.Item>
                <DropdownMenu.Item onclick={() => openLogin(account.id)}>{@render actionIcon(LogIn)}{t('ui.relogin')}</DropdownMenu.Item>
                <DropdownMenu.Item onclick={() => openAction(account.status === 'disabled' ? 'enable' : 'disable', account)}>{@render actionIcon(account.status === 'disabled' ? Power : PowerOff)}{t(account.status === 'disabled' ? 'ui.enableTitle' : 'ui.disableTitle')}</DropdownMenu.Item>
                <DropdownMenu.Separator />
                <DropdownMenu.Item class="text-red-300 focus:text-red-300" onclick={() => openAction('delete', account)}>{@render actionIcon(Trash2)}{t('ui.deleteDanger')}</DropdownMenu.Item>
              {/if}
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          </div>
        </article>
      {/each}
    </div>
  {/if}
  <p class="text-sm text-zinc-400">{t('ui.saveHelp')}</p>
</div>

<IndustrialDialog bind:open={loginOpen} busy={starting} scrollBody closeLabel={t('ui.close')} onOpenChange={(open) => { if (!open) callback = ''; }}
  title={t(reauthRef ? 'ui.relogin' : 'ui.addAccount')} description={reauthRef ? t('ui.accountIdentity', { label: accounts.find(account => account.id === reauthRef)?.label ?? reauthRef }) : t('ui.credentialsHelp')}>
  {#snippet body()}
    {#if !active && !starting}
      <RadioGroup.Root bind:value={kind} aria-label={t('ui.loginMethod')} class="flex flex-wrap gap-4">
        {#each ['device', 'pkce'] as method}<div class="flex items-center gap-2"><RadioGroup.Item id={`${id}-${method}`} value={method} /><label for={`${id}-${method}`} class="nx-field-label">{t(`ui.${method}`)}</label></div>{/each}
      </RadioGroup.Root>
      <p class="text-sm text-zinc-400">{t(kind === 'device' ? 'ui.deviceHelp' : 'ui.pkceHelp')}</p>
    {/if}
    {#if session}
      <div class="flex flex-wrap items-center justify-between gap-2"><StatusBadge variant={status === 'success' ? 'active' : ['failed', 'expired'].includes(status) ? 'fault' : 'standby'}>{t(loginStates[status as keyof typeof loginStates] ?? 'ui.statusLoading')}</StatusBadge><span class="text-sm text-zinc-400">{t('ui.sessionExpiry', { date: dateText(session.expiresAt) })}</span></div>
      {#if active && kind === 'device'}
        <div class="space-y-1.5"><span class="nx-field-label">{t('ui.deviceCode')}</span><div class="flex flex-wrap items-center justify-between gap-3"><code class="nx-display text-xl text-zinc-100 select-all">{session.userCode}</code><Button variant="outline" onclick={() => copy(session?.userCode ?? '')}>{@render actionIcon(Copy)}{t('ui.copyCode')}</Button></div></div>
      {/if}
      {#if url}
        <label class="space-y-1.5"><span class="nx-field-label">{t('ui.verificationUrl')}</span><Input readonly value={url} /></label>
        <div class="flex flex-wrap gap-2"><Button href={url} target="_blank" rel="noopener noreferrer" variant="outline">{@render actionIcon(ExternalLink)}{t('ui.openVerification')}</Button><Button variant="ghost" onclick={() => copy(url ?? '')}>{@render actionIcon(Copy)}{t('ui.copyUrl')}</Button></div>
      {/if}
      {#if kind === 'pkce' && status === 'pending'}
        <form onsubmit={submitCallback} class="space-y-3">
          <label class="block space-y-1.5"><span class="nx-field-label">{t('ui.callbackUrl')}</span><Input bind:value={callback} autocomplete="off" spellcheck={false} placeholder="http://localhost:…/auth/callback?…" /></label>
          <p class="text-sm text-zinc-400">{t('ui.callbackHelp')}</p>
          <Button type="submit" disabled={submitting || !callback.trim()} aria-busy={submitting}>{@render actionIcon(Send, submitting)}{t('ui.submitCallback')}</Button>
        </form>
      {/if}
      <p class="text-sm text-zinc-400">{t(status === 'committing' ? 'ui.committingHelp' : status === 'success' ? 'ui.successHelp' : terminal(status) ? 'ui.terminalHelp' : 'ui.activeHelp')}</p>
    {/if}
    {#if loginNotice}<p role="status" class="text-sm text-amber-300">{t(loginNotice)}</p>{/if}
  {/snippet}
  {#snippet footer()}
      {#if session}<Button variant="outline" disabled={polling} aria-busy={polling} onclick={pollStatus}>{@render actionIcon(RefreshCw, polling)}{t('ui.refreshStatus')}</Button>{/if}
      {#if active}<Button variant="outline" disabled={cancelling || status === 'committing'} aria-busy={cancelling} onclick={cancelLogin}>{@render actionIcon(X, cancelling)}{t('ui.cancelLogin')}</Button>
      {:else}<Button disabled={starting} aria-busy={starting} onclick={startLogin}>{@render actionIcon(LogIn, starting)}{t('ui.startLogin')}</Button>{/if}
  {/snippet}
</IndustrialDialog>

{#snippet accountActionFooter()}
  <Button form={`${id}-account-action`} type="submit" variant={action === 'delete' ? 'destructive' : 'default'} disabled={actionBusy} aria-busy={actionBusy}>{@render actionIcon(actionIcons[action] ?? Check, actionBusy)}{t(action === 'delete' ? 'ui.confirmDelete' : 'ui.confirm')}</Button>
{/snippet}

<IndustrialDialog bind:open={actionOpen} busy={actionBusy} scrollBody closeLabel={t('ui.close')} footer={action === 'references' ? undefined : accountActionFooter}
  title={t(actionTitles[action] ?? 'ui.more')} description={`${actionAccount?.label ?? ''} · ${actionAccount?.id ?? ''}`}>
  {#snippet body()}
    <form id={`${id}-account-action`} onsubmit={confirmAction} class="space-y-4">
      {#if action === 'rename'}<label class="block space-y-1.5"><span class="nx-field-label">{t('ui.accountName')}</span><Input bind:value={label} maxlength={128} required /></label>{/if}
      {#if ['delete', 'disable'].includes(action)}<p role="alert" class="text-sm text-amber-300">{t('ui.dangerHelp')}</p>{/if}
      {#if referenceNotice}<p role="status" class="text-sm text-zinc-400">{t(referenceNotice)}</p>{/if}
      {#if references}
        <div class="space-y-2 break-all text-sm text-zinc-400">
          <p>{t('ui.referenceCount', { revision: references.revision, services: references.services.length, routes: references.routes.length })}</p>
          {#if references.global}<p>{t('ui.globalReference')}</p>{/if}
          {#if references.services.length}<p>{t('ui.serviceReferences', { names: references.services.map(item => item.name).join(', ') })}</p>{/if}
          {#if references.routes.length}<p>{t('ui.routeReferences', { paths: references.routes.map(item => item.path).join(', ') })}</p>{/if}
          <p>{t('ui.runtimeUnknown')}</p>
        </div>
      {/if}
      {#if actionNotice}<p role="alert" class="text-sm text-red-300">{t(actionNotice)}</p>{/if}
    </form>
  {/snippet}
</IndustrialDialog>

<IndustrialDialog bind:open={useOpen} closeLabel={t('ui.close')} title={t('ui.useService')} description={t('ui.useDescription', { label: useAccount?.label ?? '' })}>
  {#snippet body()}
    <div class="space-y-1.5"><span class="nx-field-label">{t('ui.chooseService')}</span>
      <Select.Root selected={selectedService} onSelectedChange={(next) => serviceChoice = next?.value ?? 'new'}>
        <Select.Trigger class="w-full" aria-label={t('ui.chooseService')} disabled={servicesLoading}><Select.Value placeholder={t('ui.chooseService')} /></Select.Trigger>
        <Select.Content><Select.Item value="new" label={t('ui.newService')}>{t('ui.newService')}</Select.Item>{#each services.filter(service => service._uid) as service (service._uid)}<Select.Item value={service._uid!} label={service.name}>{service.name}</Select.Item>{/each}</Select.Content>
      </Select.Root>
    </div>
    {#if servicesLoading}<p role="status" class="text-sm text-zinc-400">{t('ui.servicesLoading')}</p>{/if}
    <p class="text-sm text-zinc-400">{t('ui.useHelp')}</p>
    {#if serviceError}<p role="alert" class="text-sm text-red-300">{t(serviceError)}</p><Button variant="outline" disabled={servicesLoading} aria-busy={servicesLoading} onclick={loadServices}>{@render actionIcon(RefreshCw, servicesLoading)}{t('ui.reloadServices')}</Button>{/if}
  {/snippet}
  {#snippet footer()}
    <Button disabled={servicesLoading || !!serviceError} aria-busy={servicesLoading} onclick={continueToService}>{@render actionIcon(ArrowRight, servicesLoading)}{t('ui.continue')}</Button>
  {/snippet}
</IndustrialDialog>
