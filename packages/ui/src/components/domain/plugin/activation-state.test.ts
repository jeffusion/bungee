import { addMessages, init, locale, waitLocale } from 'svelte-i18n';
import zh from '../../../i18n/locales/zh-CN.json';
import en from '../../../i18n/locales/en.json';
addMessages('zh-CN', zh);
addMessages('en', en);
init({ initialLocale: 'zh-CN', fallbackLocale: 'zh-CN' });
import {beforeEach,expect,test} from 'bun:test';
import {activationDependencies,activationBlockedReason,originMatches,accountError} from './activation-state';
import type {Plugin} from '../../../api/plugins';
beforeEach(async () => { locale.set('zh-CN'); await waitLocale(); });
const plugin = (name:string, enabled=false, dependencies:Record<string,string>={}):Plugin => ({name,enabled,dependencies});
test('activation preview traverses enabled parents, de-duplicates shared dependencies and terminates cycles',()=>{
  const consumer=plugin('consumer',false,{provider:'*',shared:'*'});
  const provider=plugin('provider',true,{shared:'*',leaf:'*'});
  const shared=plugin('shared',false,{consumer:'*'}),leaf=plugin('leaf');
  expect(activationDependencies(consumer,[consumer,provider,shared,leaf]).map(p=>p.name)).toEqual(['shared','leaf']);
  expect(provider.enabled).toBe(true);
});
test('disabled consumer does not block provider; enabled consumers and request leases provide actionable Chinese reasons',()=>{
  const provider=plugin('provider',true);
  expect(activationBlockedReason(provider,name=>'名称 '+name)).toBe('');
  expect(activationBlockedReason({...provider,dependents:['limit','budget']},name=>'名称 '+name)).toContain('名称 limit、名称 budget');
  expect(activationBlockedReason({...provider,blockedReason:'required_by:limit'},name=>name)).toContain('limit');
  expect(activationBlockedReason({...provider,blockedReason:'in_flight_requests'},name=>name)).toContain('等待请求结束');
});
test('Origin precheck rejects missing configuration, alias hosts and port differences',()=>{
  expect(originMatches(undefined,'http://localhost:60034')).toBe(false);
  expect(originMatches('http://127.0.0.1:28089','http://localhost:60034')).toBe(false);
  expect(originMatches('http://localhost:28089','http://localhost:60034')).toBe(false);
  expect(originMatches('https://example.com','https://example.com')).toBe(true);
});
test('account errors keep machine codes in detail and provide the relevant recovery action',()=>{
  expect(accountError(new Error('invalid_credentials')).message).toContain('已有管理员');
  expect(accountError(new Error('invalid_csrf')).message).toContain('重新登录');
  expect(accountError(new Error('opaque_failure')).detail).toBe('opaque_failure');
  expect(accountError(new Error('opaque_failure')).message).not.toContain('opaque_failure');
});

test('account errors retain a stable key while default translations follow the active locale', async () => {
  const failure = accountError(new Error('invalid_password'));
  expect(failure.key).toBe('pluginActivation.errors.invalid_password');
  expect(failure.message).toContain('密码');
  locale.set('en'); await waitLocale();
  expect(accountError(new Error('invalid_password')).message).toContain('password');
  expect(accountError(new Error('invalid_password')).key).toBe(failure.key);
  expect(accountError(new Error('invalid_password')).detail).toBe('invalid_password');
  const provider = {...plugin('provider', true), dependents: ['consumer']};
  expect(activationBlockedReason(provider, name => name)).toContain('First disable');
});
test('pure formatter callbacks receive core keys and dependency values without translating identifiers', () => {
  const calls: [string, unknown][] = [];
  const format = (key: string, options?: {values?: Record<string, string | number>}) => {
    calls.push([key, options?.values]); return key === 'pluginActivation.listSeparator' ? ', ' : key;
  };
  expect(activationBlockedReason({...plugin('provider', true), dependents:['one','two']}, name => name, format)).toBe('pluginActivation.blocked.requiredBy');
  expect(calls).toEqual([['pluginActivation.listSeparator', undefined], ['pluginActivation.blocked.requiredBy', {names: 'one, two'}]]);
  expect(accountError(new Error('required_by:consumer'), format)).toEqual({message:'pluginActivation.errors.requiredBy',key:'pluginActivation.errors.requiredBy',detail:'required_by:consumer'});
  for (const [name, code] of [['ConfigurationOperationDegradedError','publicationFailed'],['ConfigurationOperationTimeoutError','publicationTimeout']]) {
    const error = new Error('technical details'); error.name = name;
    expect(accountError(error, format).key).toBe(`pluginActivation.errors.${code}`);
  }
});
