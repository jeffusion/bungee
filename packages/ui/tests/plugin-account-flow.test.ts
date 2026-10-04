import {expect,test} from 'bun:test';
import {compile} from 'svelte/compiler';
const files=['../src/App.svelte','../src/routes/Plugins.svelte','../src/routes/Login.svelte','../src/components/domain/plugin/PluginActivationDialog.svelte','../../../plugins/local-accounts/ui/Login.svelte','../../../plugins/local-accounts/ui/RecoveryHelp.svelte','../../../plugins/local-accounts/ui/Settings.svelte','../../../plugins/key-access/ui/KeyPolicy.svelte','../../../plugins/key-rate-limit/ui/KeyPolicy.svelte'];
test('plugin and account surfaces compile for client and SSR without warnings',async()=>{
  for(const file of files){const source=await Bun.file(new URL(file,import.meta.url)).text();for(const generate of ['client','server'] as const)expect(compile(source,{filename:file,generate}).warnings).toEqual([]);}
});
