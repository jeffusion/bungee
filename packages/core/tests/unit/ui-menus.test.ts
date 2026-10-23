import { describe, expect, test } from 'bun:test';
import { BUILTIN_MENU_PAGES, DEFAULT_MENU_GROUPS, createDefaultMenuLayout, reconcileMenuLayout } from '@jeffusion/bungee-types';
import { validateMenuLayout } from '../../src/ui/menu-layout';
import { defaultMenuIcon, isMenuIconId, MATERIAL_MENU_ICONS, menuIconCollections, menuIcons, resolveMenuIcon, searchMenuIcons } from '../../src/ui/menu-icons';
import { menuCatalog, createMenuApi } from '../../src/master-runtime/menu-api';
import type { PluginManifestRecord } from '../../src/plugin-manifest-catalog/types';

const page = {kind:'page',pageId:'builtin:dashboard',visible:true} as const;
const group = {kind:'group',id:'group:custom',title:' Custom ',visible:true,children:[page]} as const;
const configuration = {revision:1,content_hash:`sha256:${'0'.repeat(64)}` as const,
  aggregate:{logical_configuration:{services:[],routes:[],plugins:[]},plugin_activations:[{plugin_name:'active'}]}};

describe('menu layout contract', () => {
  test('canonicalizes titles and accepts translated predefined groups', () => {
    expect(validateMenuLayout([group])[0]).toMatchObject({title:'Custom'});
    expect(validateMenuLayout(createDefaultMenuLayout(BUILTIN_MENU_PAGES))).toEqual(createDefaultMenuLayout(BUILTIN_MENU_PAGES));
    for (const preset of DEFAULT_MENU_GROUPS) {
      const predefined = {...group, id:preset.id, title:null};
      expect(validateMenuLayout([predefined])).toEqual([predefined]);
    }
  });
  test.each([
    [page,page], [group,{...group,id:'group:another'}], [group,group], [{...group,title:' '}],
    [{...group,title:null}], [{...group,children:[group]}], [{...page,unknown:true}],
    [{...page,icon:'remote:foo'}], [{...page,icon:'lucide:does-not-exist'}], [{...page,pageId:'plugin:bad:%broken'}], [{...page,pageId:'plugin:bad:/unencoded'}], [{...page,visible:1}],
    [{...group,children:[{...page,kind:'group'}]}], [{...group,id:'unsafe id'}],
  ])('rejects malformed, duplicate or nested layouts %#', (...nodes) => {
    expect(() => validateMenuLayout(nodes)).toThrow();
  });
  test('rejects unknown page additions and preserves explicitly allowed stale pages', () => {
    const stale = {...page,pageId:'plugin:removed:%2Fpage'};
    expect(() => validateMenuLayout([stale],new Set(BUILTIN_MENU_PAGES.map(p=>p.id)))).toThrow();
    expect(validateMenuLayout([stale],new Set([stale.pageId]))).toEqual([stale]);
  });
  test('catalog includes disabled plugins, stable ids and Material mappings in deterministic order', () => {
    const records = ['disabled','active'].map(name => ({name,manifest:{contributes:{navigation:[
      {label:'navigation.page',path:'/page',icon:'shield'},
    ]}}})) as unknown as PluginManifestRecord[];
    const catalog = menuCatalog(records,configuration);
    expect(catalog.filter(p=>p.source==='plugin')).toEqual([
      {id:'plugin:active:%2Fpage',label:'navigation.page',href:'/#/extensions/active/page',source:'plugin',pluginName:'active',defaultIcon:'lucide:shield',available:true},
      {id:'plugin:disabled:%2Fpage',label:'navigation.page',href:'/#/extensions/disabled/page',source:'plugin',pluginName:'disabled',defaultIcon:'lucide:shield',available:false},
    ]);
    const headerCatalog = menuCatalog([{name:'active',manifest:{contributes:{navigation:[{label:'header',path:'/header',target:'header'}]}}}] as unknown as PluginManifestRecord[], configuration);
    expect(headerCatalog.some(page => page.id === 'plugin:active:%2Fheader')).toBe(true);
    const duplicate = [{name:'active',manifest:{contributes:{navigation:[{label:'one',path:'/same'},{label:'two',path:'/same'}]}}}] as unknown as PluginManifestRecord[];
    expect(menuCatalog(duplicate,configuration).filter(page => page.source === 'plugin')).toHaveLength(1);
    expect(menuCatalog(duplicate,configuration).find(page => page.source === 'plugin')?.label).toBe('one');
    const layout = reconcileMenuLayout([page],catalog);
    expect(layout[0]).toEqual(page);
    expect(layout.filter(p=>p.kind==='page' && p.pageId==='plugin:active:%2Fpage')).toHaveLength(1);
  });
});

describe('offline icon catalog', () => {
  test('discovers licensed collections and resolves representative and all existing defaults', () => {
    expect(menuIconCollections().collections.map(c=>c.id)).toEqual(['lucide','tabler','carbon']);
    for (const collection of menuIconCollections().collections) {
      expect(collection.total).toBeGreaterThan(100);
      expect(collection.version).toBeTruthy(); expect(collection.license.title).toBeTruthy();
    }
    const ids = [...new Set(['lucide:menu','tabler:home','carbon:home','lucide:activity-square','tabler:123','carbon:app-switcher',...BUILTIN_MENU_PAGES.map(p=>p.defaultIcon),...DEFAULT_MENU_GROUPS.map(group=>group.icon),...Object.values(MATERIAL_MENU_ICONS)])];
    const result = menuIcons(ids);
    expect(result.missing).toEqual([]);
    for (const id of ids) { expect(result.icons[id]?.body).toContain('<'); expect(result.icons[id]?.width).toBeGreaterThan(0); }
    expect(defaultMenuIcon('bar_chart')).toBe('lucide:chart-no-axes-combined');
    expect(defaultMenuIcon('toString')).toBe('lucide:puzzle');
    expect(isMenuIconId('lucide:missing')).toBe(false);
    expect(menuIcons(['lucide:missing']).missing).toEqual(['lucide:missing']);
  });
  test('resolves alias rotations and flips with the Iconify utility', () => {
    const source = {prefix:'test',width:24,height:24,icons:{shape:{body:'<path d="M0 0h12v8H0z"/>'}},
      aliases:{turned:{parent:'shape',rotate:1,hFlip:true},inherited:{parent:'turned',vFlip:true}}};
    const base = resolveMenuIcon(source,'shape')!;
    const alias = resolveMenuIcon(source,'inherited')!;
    expect(alias.body).not.toBe(base.body);
    expect(alias.body).toContain('transform');
    expect(alias.width).toBe(24);
    expect(resolveMenuIcon(source,'absent')).toBeNull();
  });
  test('search covers full names, pages deterministically and maps maintained Chinese keywords', () => {
    const first = searchMenuIcons('lucide','',0,2), second = searchMenuIcons('lucide','',2,2);
    expect(first.items).toHaveLength(2); expect(second.items).toHaveLength(2);
    expect(first.items[0]?.id).not.toBe(second.items[0]?.id);
    expect(searchMenuIcons('lucide','设置',0,48).items.some(i=>i.name==='settings')).toBe(true);
    expect(searchMenuIcons('tabler','arrow',0,96).total).toBeGreaterThan(96);
  });
  test('API rejects bounds, duplicates and unknown collections, and supports authenticated-layer cache validators', async () => {
    const api = createMenuApi({repository:{async getMenuLayout(){return {revision:0,layout:null};},async putMenuLayout(){throw new Error('unused');}},catalog:{records:()=>[]}});
    const request = (path:string,headers?:HeadersInit) => api.handle(new Request(`http://test/api/ui/icons/${path}`,{headers}),configuration,async()=>true);
    for (const path of ['search?collection=unknown','search?collection=lucide&limit=97','search?collection=lucide&offset=-1',
      'search?collection=lucide&limit=0','search?collection=lucide&q=a&q=b','data?ids=lucide:home,',
      `data?ids=${Array(65).fill('lucide:home').join(',')}`,'collections?anything=true']) expect((await request(path)).status).toBe(400);
    const response = await request('search?collection=lucide&q=home&offset=0&limit=2');
    expect(response.status).toBe(200); expect((await response.json()).items.length).toBeLessThanOrEqual(2);
    const etag = response.headers.get('etag')!;
    const cached = await request('search?collection=lucide&q=home&offset=0&limit=2',{'if-none-match':etag});
    expect(cached.status).toBe(304); expect(await cached.text()).toBe('');
    expect(cached.headers.get('cache-control')).toContain('private');
    expect((await (await request('data?ids=lucide:missing')).json()).missing).toEqual(['lucide:missing']);
    const mixed = await request('data?ids=retired:example,lucide:server');
    expect(mixed.status).toBe(200);
    const icons = await mixed.json();
    expect(icons.missing).toEqual(['retired:example']);
    expect(icons.icons['lucide:server'].body).toContain('<');
  });
});
