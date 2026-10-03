import { expect, test } from 'bun:test';
import { addMessages, init, locale, _ } from 'svelte-i18n';
import { get } from 'svelte/store';
import { getPluginText } from '../../../packages/ui/src/utils/plugin-i18n';
import manifest from '../manifest.json';
import metering from '../../token-metering/manifest.json';
import { formatRate, unitLabel, createRateDraft, draftPolicy } from '../ui/rate-policy';

const text = (key:string,values?:Record<string,string|number>) => getPluginText(key,manifest.name,(id,options)=>get(_)(id,{...options,values}));
for (const language of ['en','zh-CN'] as const) addMessages(language,{plugins:{[manifest.name]:manifest.translations[language]}});
init({fallbackLocale:'en',initialLocale:'en'});

test('rate and metering metadata and UI keys have matching nonempty translations',async()=>{
  for (const plugin of [manifest,metering]) {
    expect(plugin.metadata.name).toBe('metadata.name');
    expect(plugin.metadata.description).toBe('plugin.description');
    expect(Object.keys(plugin.translations.en).sort()).toEqual(Object.keys(plugin.translations['zh-CN']).sort());
    for (const key of Object.keys(plugin.translations.en)) {
      const en=plugin.translations.en[key as keyof typeof plugin.translations.en];
      const zh=plugin.translations['zh-CN'][key as keyof typeof plugin.translations['zh-CN']];
      expect(en.length).toBeGreaterThan(0); expect(zh.length).toBeGreaterThan(0);
      expect([...en.matchAll(/\{(\w+)\}/g)].map(match=>match[1]).sort()).toEqual([...zh.matchAll(/\{(\w+)\}/g)].map(match=>match[1]).sort());
    }
  }
  const source=await Bun.file(new URL('../ui/KeyPolicy.svelte',import.meta.url)).text();
  for (const match of source.matchAll(/'((?:ui|unit|status|reason|error|feedback|notice)\.[\w]+)'/g)) expect(Object.hasOwn(manifest.translations.en,match[1])).toBe(true);
  expect(source.split('</script>')[1]).not.toMatch(/[\u4e00-\u9fff]/);
});

test('locale switches update existing rate errors, notices and summaries without changing policy data',()=>{
  const errorKey='error.unit',noticeKey='notice.capacity';
  const draft=createRateDraft({rps:20.5,burst:1230,unit:'minute'});
  const original=draftPolicy(draft);
  locale.set('en');
  expect(unitLabel('minute',text)).toBe('minute');
  expect(formatRate(original!,text,'en')).toBe('1,230 requests / minute');
  expect(text(errorKey)).toBe(manifest.translations.en[errorKey]);
  expect(text(noticeKey)).toBe(manifest.translations.en[noticeKey]);
  expect(text('ui.summary',{unit:unitLabel('minute',text),quantity:'1,230',burst:'1,230'})).toContain('1,230 requests per minute');
  expect(text('ui.editTitle',{name:'Example'})).toBe('Set rate limit · Example');
  locale.set('zh-CN');
  expect(unitLabel('minute',text)).toBe('分钟');
  expect(formatRate(original!,text,'zh-CN')).toBe('1,230 次 / 分钟');
  expect(text(errorKey)).toBe(manifest.translations['zh-CN'][errorKey]);
  expect(text(noticeKey)).toBe(manifest.translations['zh-CN'][noticeKey]);
  expect(text('ui.summary',{unit:unitLabel('minute',text),quantity:'1,230',burst:'1,230'})).toContain('每分钟平均恢复 1,230 次请求额度');
  expect(draftPolicy(draft)).toEqual(original);
});
