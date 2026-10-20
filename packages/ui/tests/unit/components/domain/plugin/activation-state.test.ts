import { addMessages, init, locale, waitLocale } from 'svelte-i18n';
import zh from '../../../../../src/i18n/locales/zh-CN.json';
import en from '../../../../../src/i18n/locales/en.json';
addMessages('zh-CN', zh);
addMessages('en', en);
init({ initialLocale: 'zh-CN', fallbackLocale: 'zh-CN' });
import {beforeEach,expect,test} from 'bun:test';
import {activationDependencies,activationBlockedReason,originMatches,accountError} from '../../../../../src/components/domain/plugin/activation-state';
import type {Plugin} from '../../../../../src/api/plugins';
beforeEach(async () => { await locale.set('zh-CN'); await waitLocale(); });
const plugin = (name:string, enabled=false, dependencies:Record<string,string>={}):Plugin => ({name,enabled,dependencies});
test('activation preview traverses enabled parents, de-duplicates shared dependencies and terminates cycles',()=>{
  const consumer=plugin('consumer',false,{provider:'*',shared:'*'});
  const provider=plugin('provider',true,{shared:'*',leaf:'*'});
  const shared=plugin('shared',false,{consumer:'*'}),leaf=plugin('leaf');
  expect(activationDependencies(consumer,[consumer,provider,shared,leaf]).map(p=>p.name)).toEqual(['shared','leaf']);
  expect(provider.enabled).toBe(true);
});
test('enabled consumers and request leases block provider disablement',()=>{
  const provider=plugin('provider',true);
  expect(activationBlockedReason(provider,name=>'名称 '+name)).toBe('');
  expect(activationBlockedReason({...provider,dependents:['limit','budget']},name=>'名称 '+name)).toBeTruthy();
  expect(activationBlockedReason({...provider,blockedReason:'required_by:limit'},name=>name)).toBeTruthy();
  expect(activationBlockedReason({...provider,blockedReason:'in_flight_requests'},name=>name)).toBeTruthy();
});
test('Origin precheck rejects missing configuration, alias hosts and port differences',()=>{
  expect(originMatches(undefined,'http://localhost:60034')).toBe(false);
  expect(originMatches('http://127.0.0.1:28089','http://localhost:60034')).toBe(false);
  expect(originMatches('http://localhost:28089','http://localhost:60034')).toBe(false);
  expect(originMatches('https://example.com','https://example.com')).toBe(true);
});

test('setup state changes and initialization conflicts retain actionable error codes',()=>{
  for (const code of ['setup_state_changed','bootstrap_conflict','already_initialized']) {
    const result=accountError(new Error(code),key=>key);
    expect(result.key).toBe(`pluginActivation.errors.${code}`);
    expect(result.detail).toBe(code);
  }
});
