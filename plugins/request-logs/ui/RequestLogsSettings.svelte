<script lang="ts">
  import { onMount } from "svelte";
  import { _, isLoading } from "$i18n";
  import { getConfigSnapshot, ConfigurationStaleError, type ConfigurationSnapshot } from "$api/config";
  import { saveLogicalConfiguration } from "$api/configuration-save";
  import { configurationWrite } from "$stores/configuration-write";
  import { settingsDirty } from "$stores/navigation-guard";
  import LoggingEditor from "$components/domain/config/LoggingEditor.svelte";
  import LogMaintenance from "$components/domain/log/LogMaintenance.svelte";
  import { resolveLoggingBody, type LoggingValue } from "$components/domain/config/logging-body";
  import { LoadingIndicator, PanelCard } from "$components/industrial";
  import { Button } from "$components/ui/button";
  import { cloneDeep } from "lodash-es";

  let { pluginName = "request-logs" }: { pluginName?: string; apiBase?: string } = $props();

  let snapshot = $state<ConfigurationSnapshot | null>(null);
  let draft = $state<Exclude<LoggingValue, null>>({});
  let baseline = $state<string>("");
  let loading = $state(true);
  let saving = $state(false);
  let error = $state("");
  let saved = $state(false);
  let invalid = $state(false);
  const dirty = $derived(!loading && !!snapshot && JSON.stringify(draft) !== baseline);
  const unresolvedWrite = $derived(!saving && !!$configurationWrite.pending && !$configurationWrite.pending.accepted);
  const saveBlocked = $derived(unresolvedWrite || $configurationWrite.corrupt);

  $effect(() => {
    settingsDirty.set(dirty);
    return () => settingsDirty.set(false);
  });

  function readSnapshot(next: ConfigurationSnapshot) {
    snapshot = next;
    draft = cloneDeep(next.config.logical_configuration.logging ?? {});
    baseline = JSON.stringify(draft);
  }

  async function load() {
    loading = true;
    error = "";
    try {
      readSnapshot(await getConfigSnapshot());
    } catch (e: any) {
      error = e?.message || ($isLoading ? "" : $_("common.error")) || "Failed to load settings";
    } finally {
      loading = false;
    }
  }

  async function handleSave() {
    if (!snapshot || !dirty || saving || saveBlocked || invalid) return;
    saving = true;
    error = "";
    saved = false;
    try {
      await saveLogicalConfiguration(snapshot, {
        ...snapshot.config.logical_configuration,
        logging: { ...draft, body: resolveLoggingBody(draft) },
      });
      readSnapshot(await getConfigSnapshot());
      saved = true;
    } catch (e: any) {
      if (e instanceof ConfigurationStaleError) {
        error = ($isLoading ? "" : $_("settings.conflict")) || "Configuration was modified elsewhere. Reload before saving.";
      } else {
        error = e?.message || ($isLoading ? "" : $_("common.error")) || "Save failed";
      }
    } finally {
      saving = false;
    }
  }

  onMount(() => {
    void load();
  });
</script>

<div class="grid w-full max-w-4xl gap-5" data-testid="request-logs-settings">
  <PanelCard title={$isLoading ? "" : $_("logging.title")} corners={false} variant="flat" flush>
    {#if loading}
      <div class="p-5"><LoadingIndicator label={$isLoading ? "" : $_("common.loading")} height="sm" /></div>
    {:else}
      <form class="flex min-w-0 flex-col gap-4 p-5" onsubmit={(e) => { e.preventDefault(); void handleSave(); }}>
        {#if !$isLoading}
          <LoggingEditor bind:value={draft} bind:invalid disabled={!snapshot || saving || saveBlocked} />
        {/if}
        {#if error}
          <p role="alert" class="border-l-2 border-red-500 pl-3 text-sm text-red-400">{error}</p>
        {/if}
        <div class="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-carbon-600 pt-4">
          {#if dirty || saved}
            <span class="text-sm {dirty ? 'text-amber-400' : 'text-emerald-400'}" role={dirty ? undefined : "status"}>
              {$isLoading ? "" : $_(dirty ? "settings.localEdits" : "settings.saved")}
            </span>
          {/if}
          <Button class="ml-auto" type="submit" data-testid="request-logs-save"
            disabled={!snapshot || !dirty || saving || saveBlocked || invalid} aria-busy={saving}>
            {$isLoading ? "" : saving ? $_("settings.submitting") : $_("common.save")}
          </Button>
        </div>
      </form>
    {/if}
  </PanelCard>
  {#if !loading}
    <PanelCard title={$isLoading ? "" : $_("settings.logMaintenance")} stripe="zinc" corners={false} variant="flat" flush>
      <LogMaintenance />
    </PanelCard>
  {/if}
</div>
