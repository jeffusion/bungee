import { expect, test } from 'bun:test';

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

test('field labels share one readable style without brightening metadata', async () => {
  const css = await read('./app.css');
  const field = css.match(/\.nx-field-label\s*\{([^}]+)\}/)?.[1] ?? '';
  for (const token of ['font-mono', 'text-sm', 'font-semibold', 'tracking-command', 'text-zinc-400']) {
    expect(field).toContain(token);
  }
  expect(css.match(/\.nx-label\s*\{([^}]+)\}/)?.[1]).toContain('text-zinc-500');
  expect(css.match(/\.nx-label-sm\s*\{([^}]+)\}/)?.[1]).toContain('text-zinc-500');
  const label = await read('./components/ui/label/label.svelte');
  expect(label).toContain('nx-field-label');
  expect(label).not.toMatch(/text-\[11px\]|text-zinc-400/);
});

test('input leaves distinguish readable placeholders, normal values and disabled states', async () => {
  for (const path of ['input/input.svelte', 'textarea/textarea.svelte']) {
    const source = await read(`./components/ui/${path}`);
    expect(source).toContain('placeholder:text-zinc-400 placeholder:font-normal');
    expect(source).toContain('font-normal text-zinc-200');
    expect(source).toContain('disabled:opacity-50');
    expect(source).not.toContain('placeholder:text-zinc-600');
  }
  const trigger = await read('./components/ui/select/select-trigger.svelte');
  expect(trigger).toContain('data-[placeholder]:[&>span]:text-zinc-400');
  expect(trigger).toContain('data-[placeholder]:[&>span]:font-normal');
  expect(trigger).toContain('font-normal text-zinc-200');
  expect(trigger).toContain('disabled:opacity-50');
  const nativeInput = (await read('./app.css')).match(/\.nx-input\s*\{([^}]+)\}/)?.[1];
  expect(nativeInput).toContain('placeholder:text-zinc-400 placeholder:font-normal');
  expect(nativeInput).toContain('font-normal text-zinc-200');
});

test('migrated field titles use the field role, not metadata captions', async () => {
  const logs = await read('./routes/Logs.svelte');
  // Only the toolbar's field titles, not page overlines or log table headings.
  const toolbar = logs.slice(logs.indexOf('<!-- 统一操作栏'), logs.indexOf('<!-- Filter Chips 展示区 -->'));
  const titles = [...toolbar.matchAll(/<span class="([^"]+)">\{\$_\('logs\.[^']+'\)\}<\/span>/g)];
  expect(titles).toHaveLength(31);
  for (const title of titles) expect(title[1]).toBe('nx-field-label');

  const fields: [string, string[]][] = [
    ['./routes/Configuration.svelte', ['configuration.logLevel', 'configuration.bodyParserLimit', 'auth.nextToken']],
    ['./routes/ServiceEditor.svelte', ['serviceEditor.serviceName', 'upstream.description']],
    ['./components/domain/route/sections/BasicInfoSection.svelte', ['routes.path', 'routeEditor.requestTimeoutMs']],
    ['./components/domain/route/sections/RetrySection.svelte', ['routeEditor.maxRetries', 'routeEditor.perRetryTimeoutMs', 'routeEditor.retryOn']],
  ];
  for (const [path, keys] of fields) {
    const source = await read(path);
    for (const key of keys) {
      expect(source).toContain(`<span class="nx-field-label">// {$_('${key}')}`);
    }
  }
  expect(logs).toContain('<span class="nx-label">// REQUEST LOGS</span>');
  expect(await read('./routes/ServiceEditor.svelte')).toContain('nx-label-sm block mb-1');
  expect(await read('./routes/Configuration.svelte')).toContain('class="text-sm text-zinc-400">{$_(\'configuration.bodyParserLimitHelp\')}');
  expect(await read('./components/domain/route/sections/RetrySection.svelte')).toContain('class="text-sm text-zinc-400">{$_(\'routeEditor.retryHelp\')}');
});

test('BSelect custom input and multiple branches keep readable normal-weight placeholders and tags', async () => {
  const source = await read('./components/industrial/BSelect.svelte');
  const inputs = [...source.matchAll(/<input\b[\s\S]*?class="([^"]+)"/g)];
  expect(inputs).toHaveLength(2); // creatable single and tags input
  for (const input of inputs) {
    expect(input[1]).toContain('font-normal text-zinc-200');
    expect(input[1]).toContain('placeholder:text-zinc-400 placeholder:font-normal');
  }
  expect(source).toContain('<span class="text-zinc-400 font-normal">{placeholder}</span>');
  const tags = [...source.matchAll(/<span class="([^"]*max-w-\[120px\][^"]*)"/g)];
  expect(tags).toHaveLength(2);
  for (const tag of tags) {
    expect(tag[1]).toContain('font-normal');
    expect(tag[1]).toContain('text-zinc-200');
  }
  expect(source).toContain('text-zinc-500 transition-colors hover:text-red-300');
  const demo = await read('./routes/DesignSystem.svelte');
  expect(demo).toContain('data-testid="design-select-creatable"');
  expect(demo).toContain('options={creatableOptions} bind:value={creatableValue} creatable allowClear');
  expect(demo).toContain('data-testid="design-select-tags"');
  expect(demo).toContain('bind:values={demoTagValues} mode="tags" allowClear');
});

test('design reference has editable bilingual values, hints, help and separate disabled fields', async () => {
  const source = await read('./routes/DesignSystem.svelte');
  const demo = source.split('data-testid="design-form-text-roles"')[1]?.split('</PanelCard>')[0] ?? '';
  expect(demo).toContain("lang: 'zh'");
  expect(demo).toContain("lang: 'en'");
  expect(demo).toContain('<Label.Root for={`form-value-${example.lang}`}');
  expect(demo).toContain('value={example.value} aria-describedby={`form-help-${example.lang}`}');
  expect(demo).toContain('class="nx-field-label"');
  expect(demo).toContain('placeholder={example.hint}');
  expect(demo).toContain('class="text-sm text-zinc-400">{example.help}');
  expect(demo).toContain('value={example.disabledValue} disabled');
  expect(demo).toContain('class="nx-label">{example.metadata}');
  expect(source).not.toMatch(/<Label\.Root[^>]*class="nx-label"/);
});
