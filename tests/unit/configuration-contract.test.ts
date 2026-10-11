import { expect, test } from 'bun:test';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workspace = resolve(import.meta.dir, '../..');
for (const file of ['packages/types/src/types.ts', 'packages/ui/src/types/index.ts']) {
  const source = ts.createSourceFile(file, readFileSync(resolve(workspace, file), 'utf8'), ts.ScriptTarget.Latest, true);
  function members(name: string) {
    const definition = source.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === name);
    if (!definition || !ts.isInterfaceDeclaration(definition)) throw new Error(`Missing contract ${name} in ${file}`);
    return new Map(definition.members.filter(ts.isPropertySignature).map(member => [member.name.getText(source), member]));
  }
  test(`${file}: route timeouts, health checks and load balancing keep their declared ownership`, () => {
    const timeout = members('RouteTimeoutsConfig');
    expect(timeout.has('request_ms')).toBe(true);
    expect(timeout.has('first_response_ms')).toBe(true);
    expect(timeout.has('connect_ms')).toBe(false);
    const service = members('Service');
    expect(service.has('sticky_session')).toBe(false);
    expect(source.statements.filter(node => (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && ['StickySessionConfig', 'ResponseRetryRule'].includes(node.name.text))).toEqual([]);
    expect(service.has('load_balancing')).toBe(true);
    expect(service.has('health_check')).toBe(true);
    if (file.startsWith('packages/ui/')) expect(service.has('timeouts')).toBe(false);
    expect(members('LoadBalancingConfig').has('policy')).toBe(true);
    expect(members('ServiceHealthCheckConfig').has('enabled')).toBe(true);
    expect(members('ServiceHealthCheckConfig').has('auto_enable_on_active_health_check')).toBe(true);
    expect(members('FailoverConfig').has('health_check')).toBe(false);
    expect(members('FailoverRecoveryConfig').has('backoff_base_ms')).toBe(true);
    expect(members('FailoverRecoveryConfig').has('probe_interval_ms')).toBe(false);
    const retry = members('FailoverConfig').get('retry_on_response')?.type;
    expect(retry && ts.isArrayTypeNode(retry) && retry.elementType.kind === ts.SyntaxKind.StringKeyword).toBe(true);
  });
}
