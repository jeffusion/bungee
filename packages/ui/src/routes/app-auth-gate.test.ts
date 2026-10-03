import {expect,test} from 'bun:test';
test('anonymous and plugin sessions verify before plugin initialization; no global credential menus',async()=>{
  const source=await Bun.file(new URL('../App.svelte',import.meta.url)).text();
  expect(source.indexOf('await verifyToken()')).toBeLessThan(source.indexOf('await loadPluginTranslations()'));
  expect(source).toContain("$authMode?.mode === 'plugin'");
  expect(source).toContain("$authMode?.mode === 'plugin' && (!$isAuthenticated || isOnLogin)");
  expect(source).not.toContain('$capabilities');
  for(const path of ['/#/keys','/#/password']) expect(source).not.toContain(path);
  expect(source).toContain('showLogout={false}');
});
test('platform login only hosts management provider login',async()=>{
  const source=await Bun.file(new URL('./Login.svelte',import.meta.url)).text();
  expect(source).toContain("$authMode.mode === 'plugin'");
  for(const removed of ['tokenInput','loginWithToken','bungee init','管理 Key']) expect(source).not.toContain(removed);
});
