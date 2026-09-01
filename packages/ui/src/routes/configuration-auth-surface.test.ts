import { describe, expect, test } from 'bun:test';

describe('configuration auth rotation surface', () => {
  test('renders the next-auth section after the form/json editor conditional', async () => {
    // Given
    const source = await Bun.file(new URL('./Configuration.svelte', import.meta.url)).text();
    const editorConditionalEnd = source.indexOf('\n    {/if}\n\n    {#if nextAuthRequired || importNextAuthRequired}');

    // When
    const nextAuthSection = source.indexOf('data-testid="next-auth-section"');

    // Then
    expect(editorConditionalEnd).toBeGreaterThan(0);
    expect(nextAuthSection).toBeGreaterThan(editorConditionalEnd);
  });
});

describe('configuration page next-auth surface', () => {
  test('next-auth section is driven only by an auth change or pending import', async () => {
    // Given
    const source = await Bun.file(new URL('./Configuration.svelte', import.meta.url)).text();

    // Then
    expect(source).toContain('$: nextAuthRequired = editingConfig?.auth?.enabled === true && authWillChange;');
  });
});

describe('configuration auth token lifecycle', () => {
  test('clears the persisted token after disabled auth converges', async () => {
    const source = await Bun.file(new URL('../api/config.ts', import.meta.url)).text();

    expect(source).toContain("import { login, logout } from '$stores/auth';");
    expect(source.match(/logout\(\);/g)).toHaveLength(2);
  });
});

describe('configuration page layout contract', () => {
  test('page root caps at max-w-7xl and centers on wide viewports', async () => {
    // Given
    const source = await Bun.file(new URL('./Configuration.svelte', import.meta.url)).text();

    // When
    const match = source.match(/<div class="([^"]*)" data-testid="page-config"/);

    // Then
    expect(match).not.toBeNull();
    const classes = match![1];
    expect(classes).toContain('max-w-7xl');
    expect(classes).toContain('mx-auto');
    expect(classes).toContain('px-6 py-5 space-y-5');
  });
});

describe('setting-row switches are icon-only with localized accessible names', () => {
  test.each([
    ['AuthEditor', '../components/domain/config/AuthEditor.svelte', 'auth.enableAuth'],
    ['LoggingEditor', '../components/domain/config/LoggingEditor.svelte', 'logging.bodyRecording'],
  ])('%s first BSwitch carries description instead of a visible label', async (_name, relative, key) => {
    // Given
    const source = await Bun.file(new URL(relative, import.meta.url)).text();

    // When
    const switchTag = source.match(/<BSwitch([\s\S]*?)\/>/)!;

    // Then
    expect(switchTag).not.toBeNull();
    const props = switchTag[1];
    expect(props).toContain(`description={$_('${key}')}`);
    expect(props).not.toContain('label=');
  });
});
