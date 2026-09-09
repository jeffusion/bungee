import { describe, expect, test } from 'bun:test';
import corePackage from '../../package.json';
import { CORE_HOST_VERSION } from '../../src/plugin-artifact-contract';
import { parsePluginManifestText, PluginManifestCatalogError } from '../../src/plugin-manifest-catalog';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'strict-plugin', version: '1.0.0', builtin: true, schemaVersion: 2,
    artifactKind: 'runtime-plugin', main: 'server/index.ts',
    capabilities: ['hooks', 'dynamicRuntimeLoad'], uiExtensionMode: 'none',
    engines: { bungee: '^4.2.0' }, configSchema: [], ...overrides,
  };
}

function rejects(value: Record<string, unknown>, fragment: string): void {
  expect(() => parsePluginManifestText(JSON.stringify(value), 'manifest.json')).toThrow(fragment);
}

function credentialManifest(policy: Record<string, unknown>, allowedHeaderNames: string[] = ['x-api-key']): Record<string, unknown> {
  return manifest({
    capabilities: ['hooks', 'api', 'dynamicRuntimeLoad', 'controlPlane'],
    control: { entry: 'server/control.ts', rpc: [{ name: 'getCredential', access: 'bound-attempt' }] },
    contributes: {
      api: [
        { path: '/accounts', methods: ['GET'], handler: 'listAccounts', execution: 'control' },
        { path: '/accounts/draft', methods: ['POST'], handler: 'createDraft', execution: 'control' },
      ],
      upstreamSources: [{
        id: 'provider', label: 'Provider', listAccounts: 'listAccounts', createDraft: 'createDraft',
        credentialPolicy: {
          allowedOrigins: ['https://api.example.com'],
          allowedHeaderNames,
          ...policy,
        },
      }],
    },
  });
}

describe('parsePluginManifestText', () => {
  test('derives the host version from the core package', () => {
    expect(CORE_HOST_VERSION).toBe(corePackage.version);
  });

  test('delegates valid range syntax to Bun semver', () => {
    const parsed = parsePluginManifestText(JSON.stringify(manifest({ engines: { bungee: '>= 4.2.0' } })));
    expect(parsed.engines.bungee).toBe('>= 4.2.0');
  });

  test('rejects invalid contract primitives and unknown nested fields', () => {
    for (const [overrides, fragment] of [
      [{ name: 'Bad Name' }, 'name'],
      [{ version: '1' }, 'version'],
      [{ schemaVersion: '2' }, 'schemaVersion'],
      [{ artifactKind: 'source-plugin' }, 'artifactKind'],
      [{ main: '../outside.ts' }, 'main'],
      [{ main: '/absolute.ts' }, 'main'],
      [{ main: 'C:\\absolute.ts' }, 'main'],
      [{ main: 'server/\u0000index.ts' }, 'main'],
      [{ capabilities: ['unknown'] }, 'capabilities'],
      [{ capabilities: ['hooks', 'hooks'] }, 'capabilities'],
      [{ uiExtensionMode: 'native-runtime' }, 'uiExtensionMode'],
      [{ version: '1.0.0-alpha.01' }, 'version'],
      [{ engines: { bungee: '^4.2.0', mystery: true } }, 'unknown field'],
      [{ engines: { bungee: '^5.0.0' } }, 'engine mismatch'],
      [{ engines: { bungee: 'latest' } }, 'engine'],
      [{ engines: { bungee: '^4.2.0', node: 'latest' } }, 'engine'],
      [{ engines: { bungee: '^4.2.0', node: '>999.0.0' } }, 'engine mismatch'],
      [{ uiExtensionMode: 'native-static', capabilities: ['hooks'] }, 'capability/ui mode mismatch'],
      [{ uiExtensionMode: 'none', capabilities: ['hooks', 'nativeWidgetsStatic'] }, 'capability/ui mode mismatch'],
      [{ uiExtensionMode: 'sandbox-iframe', capabilities: ['hooks'] }, 'capability/ui mode mismatch'],
      [{ metadata: { name: 'Name', mystery: true } }, 'unknown field'],
      [{ metadata: { contributes: {} } }, 'unknown field'],
      [{ ui: { components: [{ name: 'Widget', entry: 'ui/widget.svelte', mystery: true }] } }, 'unknown field'],
      [{ ui: { components: [{ name: 'constructor', entry: 'ui/widget.svelte' }] }, capabilities: ['hooks', 'dynamicRuntimeLoad', 'nativeWidgetsStatic'], uiExtensionMode: 'native-static' }, 'identifier'],
      [{ contributes: { api: [{ path: 'stats', methods: ['GET'], handler: 'getStats' }] }, capabilities: ['hooks', 'dynamicRuntimeLoad', 'api'] }, 'path'],
      [{ contributes: { api: [{ path: '/stats', methods: ['PATCH'], handler: 'getStats' }] }, capabilities: ['hooks', 'dynamicRuntimeLoad', 'api'] }, 'methods'],
      [{ contributes: { api: [{ path: '/stats', methods: ['GET'], handler: '__proto__' }] }, capabilities: ['hooks', 'dynamicRuntimeLoad', 'api'] }, 'identifier'],
      [{ permissions: ['shell'] }, 'permission'],
      [{ capabilities: ['hooks'] }, 'dynamicRuntimeLoad'],
      [{ capabilities: ['dynamicRuntimeLoad'] }, 'runtime capability'],
    ] satisfies readonly [Record<string, unknown>, string][]) rejects(manifest(overrides), fragment);
  });

  test('rejects inherited Object names and ECMAScript reserved words for generated identifiers', () => {
    for (const handler of [
      'toString', 'valueOf', 'hasOwnProperty', '__defineGetter__',
      '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
      'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
      'constructor', 'prototype', '__proto__',
    ]) {
      rejects(manifest({
        capabilities: ['hooks', 'dynamicRuntimeLoad', 'api'],
        contributes: { api: [{ path: '/stats', methods: ['GET'], handler }] },
      }), 'identifier');
    }
    rejects(manifest({
      capabilities: ['hooks', 'dynamicRuntimeLoad', 'nativeWidgetsStatic'],
      uiExtensionMode: 'native-static',
      ui: { components: [{ name: 'valueOf', entry: 'ui/widget.svelte' }] },
    }), 'identifier');
    rejects(manifest({ contributes: { commands: [{ command: 'hasOwnProperty', title: 'Bad' }] } }), 'identifier');
    for (const handler of ['arguments', 'await', 'class', 'eval', 'export', 'import', 'yield']) {
      rejects(manifest({
        capabilities: ['hooks', 'dynamicRuntimeLoad', 'api'],
        contributes: { api: [{ path: '/stats', methods: ['GET'], handler }] },
      }), 'identifier');
    }
    rejects(manifest({
      capabilities: ['hooks', 'dynamicRuntimeLoad', 'nativeWidgetsStatic'],
      uiExtensionMode: 'native-static',
      ui: { components: [{ name: 'class', entry: 'ui/widget.svelte' }] },
    }), 'identifier');
    rejects(manifest({ contributes: { commands: [{ command: 'import', title: 'Bad' }] } }), 'identifier');
  });

  test('rejects non-portable executable and UI path segments', () => {
    for (const entry of [
      "ui/x';process.exit();x.svelte",
      'ui/x`process.svelte',
      'ui/x\nprocess.svelte',
      'ui/x;process.svelte',
      'ui\\widget.svelte',
    ]) {
      rejects(manifest({
        capabilities: ['hooks', 'dynamicRuntimeLoad', 'nativeWidgetsStatic'],
        uiExtensionMode: 'native-static', ui: { components: [{ name: 'Widget', entry }] },
      }), 'path segment');
    }
  });

  test('rejects unsafe JSON text and prototype-polluting keys', () => {
    expect(() => parsePluginManifestText('{"name":"bad\\ud800"}', 'manifest.json')).toThrow(PluginManifestCatalogError);
    expect(() => parsePluginManifestText(JSON.stringify(manifest()).replace('"configSchema":[]', '"configSchema":[],"__proto__":{}')))
      .toThrow('forbidden');
  });

  test('rejects duplicate decoded keys and bounded-resource abuse before JSON.parse', () => {
    expect(() => parsePluginManifestText('{"name":"a","na\\u006de":"b"}', 'manifest.json')).toThrow('duplicate');
    expect(() => parsePluginManifestText('{"outer":{"x":1,"x":2}}', 'manifest.json')).toThrow('duplicate');
    expect(() => parsePluginManifestText(`{"name":"${'x'.repeat(70_000)}"}`, 'manifest.json')).toThrow('string');
    expect(() => parsePluginManifestText(`{"padding":"${'x'.repeat(262_144)}"}`, 'manifest.json')).toThrow('size');
    expect(() => parsePluginManifestText(`${'['.repeat(40)}0${']'.repeat(40)}`, 'manifest.json')).toThrow('depth');
    expect(() => parsePluginManifestText(`[${Array.from({ length: 9_000 }, () => '0').join(',')}]`, 'manifest.json')).toThrow('node');
  });

  test('validates recursive fields, options, defaults, and validation rules', () => {
    const invalidFields: readonly [Record<string, unknown>, string][] = [
      [{ name: '__proto__', type: 'string', label: 'Bad' }, 'field name'],
      [{ name: 'x', type: 'unknown', label: 'Bad' }, 'type'],
      [{ name: 'x', type: 'string', label: 'Bad', options: [] }, 'options'],
      [{ name: 'x', type: 'select', label: 'Bad', options: [] }, 'options'],
      [{ name: 'x', type: 'select', label: 'Bad', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'a' }] }, 'unique'],
      [{ name: 'x', type: 'number', label: 'Bad', default: '1' }, 'default'],
      [{ name: 'x', type: 'number', label: 'Bad', default: 1, validation: { min: 2 } }, 'default'],
      [{ name: 'x', type: 'string', label: 'Bad', validation: { pattern: '^z' } }, 'unknown field'],
      [{ name: 'x', type: 'multiselect', label: 'Bad', default: ['a', 'a'], options: [{ label: 'A', value: 'a' }] }, 'default'],
      [{ name: 'x', type: 'model_mapping', label: 'Bad', default: [{ source: 'a' }] }, 'default'],
      [{ name: 'x', type: 'json', label: 'Bad', default: '{broken' }, 'default'],
      [{ name: 'x', type: 'json', label: 'Bad', default: '{"a":1,"a":2}' }, 'default'],
      [{ name: 'x', type: 'string', label: 'Bad', validation: { min: 2, max: 1 } }, 'min'],
      [{ name: 'x', type: 'boolean', label: 'Bad', validation: { pattern: '^x' } }, 'pattern'],
      [{ name: 'x', type: 'number', label: 'Bad', validation: { min: 1.5 } }, 'safe integer'],
      [{ name: 'x', type: 'object', label: 'Bad' }, 'properties'],
      [{ name: 'x', type: 'array', label: 'Bad' }, 'items'],
      [{ name: 'x', type: 'boolean', label: 'Bad', properties: [] }, 'properties'],
      [{ name: 'x', type: 'select', label: 'Bad', options: [{ label: 'A', value: 'a-b' }], fieldTransform: { type: 'split', separator: '-', fields: ['constructor'] } }, 'field name'],
      [{ name: 'x', type: 'string', label: 'Bad', fieldTransform: { type: 'concat', fields: ['a'] } }, 'unsupported fieldTransform'],
      [{ name: 'x', type: 'string', label: 'Bad', fieldTransform: { type: 'split', separator: '-', fields: ['from', 'to'] } }, 'select'],
      [{ name: 'x', type: 'textarea', label: 'Bad', fieldTransform: { type: 'split', separator: '-', fields: ['from', 'to'] } }, 'select'],
      [{ name: 'x', type: 'string', label: 'Bad', catalogPlugin: 'model-mapping' }, 'model_mapping'],
      [{ name: 'x', type: 'object', label: 'Bad', properties: [
        { name: 'same', type: 'string', label: 'A' }, { name: 'same', type: 'string', label: 'B' },
      ] }, 'duplicate'],
    ];
    for (const [field, fragment] of invalidFields) {
      rejects(manifest({ configSchema: [field] }), fragment);
    }
  });

  test('accepts validation.trimmed and rejects unknown validation keys', () => {
    const parsed = parsePluginManifestText(JSON.stringify(manifest({
      configSchema: [{ name: 'accountRef', type: 'string', label: 'Account', validation: { trimmed: true } }],
    })));
    expect(parsed.configSchema[0]?.validation).toEqual({ trimmed: true });
    rejects(manifest({
      configSchema: [{ name: 'accountRef', type: 'string', label: 'Account', validation: { trimmed: true, unknown: true } }],
    }), 'unknown field');
  });

  test('validates showIf references, transform targets, cycles, and nesting depth', () => {
    rejects(manifest({ configSchema: [{ name: 'x', type: 'string', label: 'X', showIf: { field: 'missing', value: true } }] }), 'showIf');
    rejects(manifest({ configSchema: [
      { name: 'a', type: 'string', label: 'A', showIf: { field: 'b', value: 'b' } },
      { name: 'b', type: 'string', label: 'B', showIf: { field: 'a', value: 'a' } },
    ] }), 'cycle');
    rejects(manifest({ configSchema: [{ name: 'x', type: 'boolean', label: 'X', fieldTransform: {
      type: 'split', separator: '-', fields: ['from', 'to'],
    } }] }), 'fieldTransform');
    rejects(manifest({ configSchema: [{ name: 'mapping', type: 'model_mapping', label: 'Mapping',
      catalogPlugin: 'model-mapping', sourceCatalogProviderField: 'missing' }] }), 'unknown provider field');
    rejects(manifest({ configSchema: [
      { name: 'enabled', type: 'boolean', label: 'Enabled' },
      { name: 'mode', type: 'string', label: 'Mode', showIf: { field: 'enabled', value: 'true' } },
    ] }), 'showIf value');
    rejects(manifest({ configSchema: [
      { name: 'enabled', type: 'boolean', label: 'Enabled' },
      { name: 'mapping', type: 'model_mapping', label: 'Mapping',
        sourceCatalogProviderField: 'enabled', targetCatalogProviderField: 'enabled' },
    ] }), 'string-compatible');

    let condition: Record<string, unknown> = { field: 'x', value: true };
    for (let index = 0; index < 40; index += 1) condition = { all: [condition] };
    rejects(manifest({ configSchema: [{ name: 'x', type: 'boolean', label: 'X', showIf: condition }] }), 'depth');

    let nested: Record<string, unknown> = { name: 'leaf', type: 'string', label: 'Leaf' };
    for (let index = 0; index < 30; index += 1) {
      nested = { name: `level_${index}`, type: 'object', label: 'Level', properties: [nested] };
    }
    rejects(manifest({ configSchema: [nested] }), 'depth');
    rejects(manifest({ configSchema: [{
      name: 'rows', type: 'array', label: 'Rows', items: {
        name: 'row', type: 'object', label: 'Row', properties: [
          { name: 'value', type: 'string', label: 'Value', showIf: { field: 'missing', value: true } },
        ],
      },
    }] }), 'unknown showIf');
    rejects(manifest({ configSchema: [{
      name: 'rows', type: 'array', label: 'Rows', items: {
        name: 'row', type: 'object', label: 'Row', properties: [
          { name: 'mapping', type: 'model_mapping', label: 'Mapping', sourceCatalogProviderField: 'missing' },
        ],
      },
    }] }), 'unknown provider');
  });

  test('rejects JSON numbers that decode outside the finite domain', () => {
    const content = JSON.stringify(manifest()).replace('"configSchema":[]',
      '"configSchema":[{"name":"x","type":"number","label":"X","default":1e999}]');
    expect(() => parsePluginManifestText(content, 'manifest.json')).toThrow('non-JSON');
  });

  test('accepts recursive valid schemas and transform target references', () => {
    const parsed = parsePluginManifestText(JSON.stringify(manifest({ configSchema: [
      { name: 'direction', type: 'select', label: 'Direction', options: [
        { label: 'A-B', value: 'a-b' },
      ], fieldTransform: { type: 'split', separator: '-', fields: ['from', 'to'] } },
      { name: 'mode', type: 'select', label: 'Mode', default: 'x', options: [{ label: 'X', value: 'x' }],
        showIf: { all: [{ field: 'from', value: 'a' }, { field: 'to', value: 'b' }] } },
      { name: 'mapping', type: 'model_mapping', label: 'Mapping', catalogPlugin: 'model-mapping',
        sourceCatalogProviderField: 'from', targetCatalogProviderField: 'to' },
      { name: 'nested', type: 'object', label: 'Nested', properties: [
        { name: 'items', type: 'array', label: 'Items', items: { name: 'item', type: 'number', label: 'Item', validation: { min: 0 } } },
      ], default: { items: [1, 2] } },
    ] })));
    expect(parsed.configSchema).toHaveLength(4);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  test('validates control entries, control APIs, and credential policies', () => {
    const parsed = parsePluginManifestText(JSON.stringify(manifest({
      capabilities: ['hooks', 'api', 'dynamicRuntimeLoad', 'controlPlane'],
      control: { entry: 'server/control.ts', rpc: [
        { name: 'getCredential', access: 'bound-attempt' },
        { name: 'rejectAccess', access: 'bound-attempt' },
      ] },
      contributes: {
        api: [
          { path: '/accounts', methods: ['GET'], handler: 'listAccounts', execution: 'control' },
          { path: '/accounts/draft', methods: ['POST'], handler: 'createDraft', execution: 'control' },
        ],
        upstreamSources: [{
          id: 'provider', label: 'Provider', listAccounts: 'listAccounts', createDraft: 'createDraft',
          credentialPolicy: {
            allowedOrigins: ['https://api.example.com'],
            allowedRequests: [{ pathname: '/v1/accounts', methods: ['GET'] }],
            allowedHeaderNames: ['x-api-key'],
          },
        }],
      },
    })));
    expect(parsed.control?.rpc[0]?.access).toBe('bound-attempt');
    expect(parsed.contributes?.api?.[0]?.execution).toBe('control');
    expect(parsed.contributes?.upstreamSources?.[0]?.credentialPolicy.allowedOrigins)
      .toEqual(['https://api.example.com']);
    rejects(manifest({
      capabilities: ['hooks', 'api', 'dynamicRuntimeLoad'],
      contributes: { api: [{ path: '/x', methods: ['GET'], handler: 'x', execution: 'control' }] },
    }), 'controlPlane');
    rejects(manifest({
      capabilities: ['hooks', 'dynamicRuntimeLoad'],
      control: { entry: 'server/control.ts', rpc: [] },
    }), 'mismatch');
  });

  test('keeps credential header allowlists strict while permitting credential headers', () => {
    const parsed = parsePluginManifestText(JSON.stringify(credentialManifest(
      { allowedRequests: [{ pathname: '/v1/chat', methods: ['POST'] }] },
      ['Authorization', 'Chatgpt-Account-Id'],
    )));
    expect(parsed.contributes?.upstreamSources?.[0]?.credentialPolicy.allowedHeaderNames)
      .toEqual(['Authorization', 'Chatgpt-Account-Id']);
    for (const header of [
      'Host', 'Content-Length', 'Accept-Encoding', 'Keep-Alive', 'Proxy-Authenticate',
      'Proxy-Authorization', 'TE', 'Trailer', 'Transfer-Encoding', 'Upgrade',
      'Cookie', 'Set-Cookie', 'X-Forwarded-For', 'Sec-Fetch-Site',
    ]) {
      rejects(credentialManifest(
        { allowedRequests: [{ pathname: '/v1/chat', methods: ['POST'] }] },
        [header],
      ), 'forbidden');
    }
  });

  test('resolves upstream operations only through declared control APIs', () => {
    const base = {
      capabilities: ['hooks', 'api', 'dynamicRuntimeLoad', 'controlPlane'],
      control: { entry: 'server/control.ts', rpc: [
        { name: 'getCredential', access: 'bound-attempt' },
        { name: 'rejectAccess', access: 'bound-attempt' },
      ] },
      contributes: {
        api: [
          { path: '/accounts', methods: ['GET'], handler: 'listAccounts', execution: 'control' },
          { path: '/accounts/draft', methods: ['POST'], handler: 'createDraft', execution: 'control' },
        ],
        upstreamSources: [{
          id: 'provider', label: 'Provider', listAccounts: 'listAccounts', createDraft: 'createDraft',
          credentialPolicy: {
            allowedOrigins: ['https://api.example.com'],
            allowedRequests: [{ pathname: '/v1/accounts', methods: ['GET'] }],
            allowedHeaderNames: ['x-api-key'],
          },
        }],
      },
    };
    expect(parsePluginManifestText(JSON.stringify(manifest(base))).contributes?.upstreamSources).toHaveLength(1);
    for (const [field, api] of [
      ['listAccounts', { path: '/accounts', methods: ['GET'], handler: 'listAccounts', execution: 'worker' }],
      ['createDraft', { path: '/accounts/draft', methods: ['GET'], handler: 'createDraft', execution: 'control' }],
    ] as const) {
      const source = structuredClone(base) as Record<string, any>;
      source.contributes.api = [api, ...base.contributes.api.filter((item) => item.handler !== api.handler)];
      rejects(manifest(source), field === 'listAccounts' ? 'execution control' : 'POST');
    }
    const unknown = structuredClone(base) as Record<string, any>;
    unknown.contributes.upstreamSources[0].listAccounts = 'notDeclared';
    rejects(manifest(unknown), 'unknown control API handler');
  });

  test('round-trips a closed-world outbound header profile', () => {
    const outboundHeaders = {
      passthrough: ['User-Agent', 'Originator'],
      set: { Accept: 'application/json', 'Content-Type': 'application/json' },
    };
    const parsed = parsePluginManifestText(JSON.stringify(credentialManifest({
      allowedRequests: [{ pathname: '/v1/chat', methods: ['POST'], outboundHeaders }],
    })));
    expect(parsed.contributes?.upstreamSources?.[0]?.credentialPolicy.allowedRequests).toEqual([{
      pathname: '/v1/chat', methods: ['POST'], outboundHeaders,
    }]);
    expect(Object.isFrozen(parsed.contributes?.upstreamSources?.[0]?.credentialPolicy.allowedRequests[0]?.outboundHeaders)).toBe(true);
  });

  test('rejects malformed or conflicting outbound header profiles', () => {
    const valid = { passthrough: ['User-Agent'], set: { Accept: 'application/json' } };
    const cases: readonly [Record<string, unknown>, string][] = [
      [{ outboundHeaders: { ...valid, mystery: true } }, 'unknown field'],
      [{ outboundHeaders: { passthrough: ['User-Agent', 'user-agent'], set: {} } }, 'unique'],
      [{ outboundHeaders: { passthrough: ['User-Agent'], set: { 'user-agent': 'x' } } }, 'conflicts'],
      [{ outboundHeaders: { passthrough: ['Authorization'], set: {} } }, 'forbidden'],
      [{ outboundHeaders: { passthrough: ['x-forwarded-for'], set: {} } }, 'forbidden'],
      [{ outboundHeaders: { passthrough: ['sec-fetch-site'], set: {} } }, 'forbidden'],
      [{ outboundHeaders: { passthrough: ['X-Api-Key'], set: {} } }, 'forbidden'],
      [{ outboundHeaders: { passthrough: ['x-api-key'], set: {} } }, 'forbidden'],
      [{ outboundHeaders: { passthrough: [], set: { Accept: ' value' } } }, 'fixed header value'],
      [{ outboundHeaders: { passthrough: [], set: { Accept: 'a\r\nb' } } }, 'fixed header value'],
      [{ outboundHeaders: { passthrough: [], set: { Accept: 'a\u0000b' } } }, 'fixed header value'],
      [{ outboundHeaders: { passthrough: [], set: { Accept: 'x'.repeat(8193) } } }, 'too large'],
      [{ outboundHeaders: { passthrough: [], set: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`X-${i}`, 'x'])) } }, 'too many'],
      [{ outboundHeaders: { passthrough: Array.from({ length: 33 }, (_, i) => `X-${i}`), set: {} } }, 'too many'],
      [{ outboundHeaders: { passthrough: [], set: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`X-${i}`, 'x'.repeat(8192)])) } }, 'too large'],
    ];
    for (const [profile, fragment] of cases) {
      rejects(credentialManifest({ allowedRequests: [{ pathname: '/v1/chat', methods: ['POST'], ...profile }] }), fragment);
    }
    rejects(credentialManifest({
      allowedRequests: [
        { pathname: '/v1/chat', methods: ['POST'] },
        { pathname: '/v1/chat', methods: ['POST'] },
      ],
    }), 'pathname and method');
    rejects(credentialManifest({
      allowedRequests: [{ pathname: '/v1/chat', methods: ['POST'], outboundHeaders: valid }],
    }, ['x-api-key', 'X-API-KEY']), 'unique');
    rejects(credentialManifest({
      allowedRequests: [{ pathname: '/v1/chat', methods: ['POST'], outboundHeaders: valid }],
    }, ['User-Agent']), 'conflicts');
  });
});
