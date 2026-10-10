import { expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';

const editor = await Bun.file(new URL('../../../src/routes/RouteEditor.svelte', import.meta.url)).text();
const navigation = editor.split('// Navigation items')[1]?.split('</script>')[0] ?? '';
const forward = editor.split("{:else if activeSection === 'forward'}")[1]?.split("{:else if activeSection === 'processing'}")[0] ?? '';
const processing = editor.split("{:else if activeSection === 'processing'}")[1]?.split("{:else if activeSection === 'policy'}")[0] ?? '';
const review = editor.split("{:else if activeSection === 'review'}")[1]?.split('<!-- ===== Bottom action bar')[0] ?? '';

test('eight four-character route sections keep the existing processing deep link for request rewrites', async () => {
  expect(compile(editor, { filename: 'RouteEditor.svelte' }).warnings).toEqual([]);
  const sections = [...navigation.matchAll(/id: '(match|target|forward|processing|policy|response|plugins|review)'\s+as RouteEditorSection/g)].map((match) => match[1]);
  expect(sections).toEqual(['match', 'target', 'forward', 'processing', 'policy', 'response', 'plugins', 'review']);
  expect(editor).toContain("const valid: RouteEditorSection[] = ['match', 'target', 'forward', 'processing', 'policy', 'response', 'plugins', 'review']");
  expect(forward).toContain('showOnly="timeouts"');
  expect(forward).toContain('<RetrySection bind:route />');
  expect(processing).toContain('<ModificationSection bind:route />');
  expect(processing).not.toContain('showOnly="timeouts"');
  expect(processing).not.toContain('<RetrySection');
  expect(editor).toContain("localStorage.setItem('bungee-route-draft', JSON.stringify(route))");
  for (const locale of ['zh-CN', 'en']) {
    const { routeEditor } = await Bun.file(new URL(`../../../src/i18n/locales/${locale}.json`, import.meta.url)).json();
    if (locale === 'zh-CN') {
      expect(sections.map((section) => routeEditor.builder[section])).toEqual([
        '路径匹配', '目标配置', '转发策略', '请求改写', '访问策略', '响应规则', '路由插件', '配置回顾',
      ]);
      expect(sections.every((section) => [...routeEditor.builder[section]].length === 4)).toBe(true);
    } else {
      expect(routeEditor.builder.forward).toBe('Forwarding Policy');
      expect(routeEditor.builder.processing).toBe('Request Rewriting');
    }
  }
});

test('Ctrl/Cmd+1–8 targets visible nav order, with a matching shortcut hint', () => {
  expect(editor).toContain("event.key >= '1' && event.key <= '8'");
  expect(editor).toContain('navItems[parseInt(event.key) - 1]?.id');
  expect(editor).toContain('<EditorNavigation');
  expect(editor).toContain('items={navItems}');
});

test('timeout validation returns to forwarding policy rather than request rewriting', () => {
  expect(editor).toContain("if (allErrors.some((error) => error.field.startsWith('timeouts.'))) activeSection = 'forward'");
  expect(editor).not.toContain("activeSection = 'processing';\n        return;");
});

test('review groups timeout values and retry with forwarding, not access policy', async () => {
  const forwarding = review.split("{$_('routeEditor.builder.forward')}")[1]?.split("{$_('routeEditor.builder.policy')}")[0] ?? '';
  const policy = review.split("{$_('routeEditor.builder.policy')}")[1]?.split('</div>')[0] ?? '';
  expect(forwarding).toContain('route.timeouts?.request_ms ?? DEFAULT_REQUEST_MS');
  expect(forwarding).toContain('route.timeouts?.request_ms === undefined');
  expect(forwarding).toContain('route.timeouts?.first_response_ms !== undefined');
  expect(forwarding).toContain('route.timeouts.first_response_ms');
  expect(forwarding).toContain("routeEditor.review.noAdditionalHeaderDeadline");
  expect(forwarding).toContain("routeEditor.review.retry");
  expect(policy).not.toContain("routeEditor.review.retry");
  for (const locale of ['zh-CN', 'en']) {
    const { routeEditor } = await Bun.file(new URL(`../../../src/i18n/locales/${locale}.json`, import.meta.url)).json();
    expect(routeEditor.review.noAdditionalHeaderDeadline).toMatch(locale === 'zh-CN' ? /仅受单次请求时限控制/ : /subject to the per-attempt request limit/);
    expect(routeEditor.review.noAdditionalHeaderDeadline).not.toMatch(/5000|5 秒|5s/);
  }
});
