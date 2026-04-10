import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Token Stats v2 Widget Consumer Contract', () => {
  const pluginDir = join(process.cwd(), 'plugins/token-stats');
  const widgetPath = join(pluginDir, 'ui/TokenStatsChart.svelte');
  const manifestPath = join(pluginDir, 'manifest.json');

  test('Widget should explicitly support "all | route | upstream | provider" dimensions', () => {
    const widgetContent = readFileSync(widgetPath, 'utf-8');
    
    // The widget must support these 4 dimensions in its type definition
    expect(widgetContent).toContain(`type GroupByDimension = 'all' | 'route' | 'upstream' | 'provider'`);
    
    // The UI must have a button for the provider dimension
    expect(widgetContent).toContain(`selectedDimension = 'provider'`);
  });

  test('Widget should declare and consume the current authority breakdown shape', () => {
    const widgetContent = readFileSync(widgetPath, 'utf-8');

    expect(widgetContent).toMatch(/type AuthorityBreakdown = \{\n\s+input: Record<AuthorityKey, number>;\n\s+output: Record<AuthorityKey, number>;\n\s+\};/);
    expect(widgetContent).toContain('authorityBreakdown: AuthorityBreakdown;');
    expect(widgetContent).toContain('function getAuthoritySections(breakdown?: AuthorityBreakdown)');
    expect(widgetContent).toContain('entries: getAuthorityEntries(breakdown?.input)');
    expect(widgetContent).toContain('entries: getAuthorityEntries(breakdown?.output)');
  });

  test('Widget should request /stats with correct range and groupBy parameters', () => {
    const widgetContent = readFileSync(widgetPath, 'utf-8');
    
    expect(widgetContent).toContain('/stats?range=${selectedRange}&groupBy=${selectedDimension}');
  });

  test('Widget should gracefully handle API empty state and 500 error state', () => {
    const widgetContent = readFileSync(widgetPath, 'utf-8');
    
    // Assert widget renders empty fallback correctly
    expect(widgetContent).toContain(`$_('tokenStats.noData')`);
    
    // Assert widget renders error state correctly
    expect(widgetContent).toContain('alert-error');
    expect(widgetContent).toContain('{error}');
  });

  test('Widget manifest defaults must match expected plugin registry bindings', () => {
    const manifestContent = readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestContent);
    
    const widgets = manifest.contributes?.nativeWidgets || [];
    const chartWidget = widgets.find((w: any) => w.id === 'token-stats-chart');
    
    expect(chartWidget).toBeDefined();
    expect(chartWidget.component).toBe('TokenStatsChart');
  });
});
