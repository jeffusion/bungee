import {fileURLToPath} from 'node:url';
import { expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';
import { addMessages, init, locale, _ } from 'svelte-i18n';
import { get } from 'svelte/store';
import { getPluginText } from '../../../packages/ui/src/utils/plugin-i18n';
import manifest from '../manifest.json';
import { formatBudget, formatBudgetDate, formatBudgetPeriod, periodLabels, budgetUsed } from '../ui/budget-view';

const text = (key:string,values?:Record<string,string|number>) => getPluginText(key,manifest.name,(id,options)=>get(_)(id,{...options,values}));
for (const language of ['en','zh-CN'] as const) addMessages(language,{plugins:{[manifest.name]:manifest.translations[language]}});
init({fallbackLocale:'en',initialLocale:'en'});

test('budget UI translations cover both locales and compile without warnings',async()=>{
  expect(manifest.metadata.name).toBe('metadata.name');
  expect(manifest.metadata.description).toBe('plugin.description');
  expect(Object.keys(manifest.translations.en).sort()).toEqual(Object.keys(manifest.translations['zh-CN']).sort());
  for(const key of Object.keys(manifest.translations.en)) {
    const en=manifest.translations.en[key as keyof typeof manifest.translations.en];
    const zh=manifest.translations['zh-CN'][key as keyof typeof manifest.translations['zh-CN']];
    expect(en.length).toBeGreaterThan(0); expect(zh.length).toBeGreaterThan(0);
    expect([...en.matchAll(/\{(\w+)\}/g)].map(match=>match[1]).sort()).toEqual([...zh.matchAll(/\{(\w+)\}/g)].map(match=>match[1]).sort());
  }
  const filename=fileURLToPath(new URL('../ui/KeyPolicy.svelte', import.meta.url));
  const source=await Bun.file(filename).text();
  for (const match of source.matchAll(/'((?:ui|unit|status|reason|error|feedback)\.[\w]+)'/g)) expect(Object.hasOwn(manifest.translations.en,match[1])).toBe(true);
  expect(source.split('</script>')[1]).not.toMatch(/[\u4e00-\u9fff]/);
  for (const generate of ['client','server'] as const) expect(compile(source,{filename,generate}).warnings).toEqual([]);
});

test('budget locale switching updates held errors, periods and interpolated usage',()=>{
  const policy={mode:'daily',unit:'usd',limit:1234.56789};
  const errorKey='error.usd';
  const usage={cumulative:0,monthly:{},unresolved:{},money:{cumulativeNanoUsd:0,monthlyNanoUsd:{},weeklyNanoUsd:{},dailyNanoUsd:{'2026-10-03':123456789},unresolved:{}}};
  const now=Date.parse('2026-10-03T00:00:00Z');
  const used=budgetUsed(usage,policy.mode,policy.unit,now);
  locale.set('en');
  expect(text(periodLabels.daily)).toBe('Daily');
  expect(text(errorKey)).toBe(manifest.translations.en[errorKey]);
  expect(text('ui.recorded',{period:text(periodLabels.daily),value:formatBudget(used,'usd','en'),unit:text('unit.usd')})).toBe('Daily recorded usage: 0.123456789 USD.');
  expect(text('ui.periodUsed',{period:text(periodLabels.daily)})).toBe('Daily usage');
  locale.set('zh-CN');
  expect(text(periodLabels.daily)).toBe('每日');
  expect(text(errorKey)).toBe(manifest.translations['zh-CN'][errorKey]);
  expect(text('ui.recorded',{period:text(periodLabels.daily),value:formatBudget(used,'usd','zh-CN'),unit:text('unit.usd')})).toBe('每日已记录 0.123456789 USD。');
  expect(text('ui.periodUsed',{period:text(periodLabels.daily)})).toBe('每日已用');
  expect(budgetUsed(usage,policy.mode,policy.unit,now)).toBe(used);
  expect(policy).toEqual({mode:'daily',unit:'usd',limit:1234.56789});
});

test('budget formatting accepts the selected number locale and retains monetary precision',()=>{
  expect(formatBudget(1234.56789,'usd','en')).toBe('1,234.56789');
  expect(formatBudget(1234.56789,'usd','de')).toBe('1.234,56789');
  expect(formatBudget(0.000000001,'usd','en')).toBe('0.000000001');
  expect(formatBudget(1234,'tokens','en')).toBe('1,234');
});


test('budget dates use the selected locale and retain UTC period boundaries',()=>{
  const now=Date.parse('2026-10-04T23:59:59Z');
  expect(formatBudgetPeriod('weekly',now,'en')).toBe('09/28/2026 UTC');
  expect(formatBudgetPeriod('weekly',now,'zh-CN')).toBe('2026/09/28 UTC');
  expect(formatBudgetPeriod('monthly',now,'en')).toBe('October 2026 UTC');
  expect(formatBudgetDate(now,'en')).toContain('10/4/2026');
  expect(formatBudgetDate(now,'zh-CN')).toContain('2026/10/4');
  expect(formatBudgetDate(now,'en')).toContain('UTC');
});
