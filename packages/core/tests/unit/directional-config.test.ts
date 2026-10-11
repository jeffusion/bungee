import { describe, expect, test } from 'bun:test';
import { analyzeExpressionDependencies, hasBodyModification } from '../../src/utils/expression-dependencies';
import { evaluateExpression, processDynamicValue } from '../../src/expression-engine';
import { parseNormalizeCompileAggregate } from '../../src/config-storage/aggregate';

const routeId = '10000000-0000-4000-8000-000000000001';
const endpointId = '20000000-0000-4000-8000-000000000001';
function aggregate(route: Record<string, unknown> = {}, endpoint: Record<string, unknown> = {}): any {
  return { logical_configuration: { services: [], plugins: [], routes: [{ id: routeId, position: 0, path: '/api', plugins: [], ...route,
    endpoints: [{ id: endpointId, position: 0, target: 'https://example.com', weight: 100, priority: 1, is_disabled: false, plugins: [], ...endpoint }] }] }, plugin_activations: [] };
}
const legacy = () => aggregate({ headers: { add: { 'x-route': 'route' } }, query: { remove: ['token'] }, body: { add: { route: true } } },
  { headers: { replace: { authorization: '{{headers.authorization}}' } }, body: { replace: { value: '{{headers.token}}', literal: '{{"headers.token"}}' } } });

describe('directional configuration and dependency contracts', () => {
  test('AST distinguishes references from literals, static keys, and request headers', () => {
    expect(analyzeExpressionDependencies({ a: '{{ "body request.body response.body" }}', b: '{{headers.body}}', c: '{{request.headers.body}}' })).toEqual({ requestBody: false, responseBody: false });
    expect(analyzeExpressionDependencies('{{body.model ?? request["body"].model}}')).toEqual({ requestBody: true, responseBody: false });
    expect(analyzeExpressionDependencies('{{request.headers[body.key]}}')).toEqual({ requestBody: true, responseBody: false });
    expect(analyzeExpressionDependencies('{{response?.body?.ok && request.body.ok}}', 'response')).toEqual({ requestBody: true, responseBody: true });
    expect(analyzeExpressionDependencies('{{({body:"text"}).body}}')).toEqual({ requestBody: false, responseBody: false });
    expect(() => analyzeExpressionDependencies('{{response.headers.status}}')).toThrow('unavailable');
    expect(hasBodyModification({ add: {}, remove: [], replace: {}, default: {} })).toBe(false);
    expect(hasBodyModification({ default: { enabled: false } })).toBe(true);
    expect(hasBodyModification({ replace: { value: null } })).toBe(true);
  });
  test('new roots preserve false and null values', () => {
    const context: any = { headers: { current: 'response' }, body: { current: null }, request: { headers: { source: 'request' }, body: { ok: false } },
      response: { headers: { current: 'response' }, body: { current: null } }, url: {pathname:'/', search:'',host:'example.com',protocol:'https:'}, method:'POST', env:{} };
    expect(evaluateExpression('request.body.ok', context)).toBe(false);
    expect(processDynamicValue('{{response.body.current}}', context)).toBeNull();
    expect(processDynamicValue('{{headers.current}}', context)).toBe('response');
  });
  test('compiler rejects old schema, response in request phase, and SSE response-body header dependencies', () => {
    expect(parseNormalizeCompileAggregate(legacy()).ok).toBe(false);
    expect(parseNormalizeCompileAggregate(aggregate({request:{body:{replace:{ok:'{{response.body.ok}}'}}}})).ok).toBe(false);
    expect(parseNormalizeCompileAggregate(aggregate({response:{headers:{add:{ok:'{{body.ok}}'}}}})).ok).toBe(false);
    expect(parseNormalizeCompileAggregate(aggregate({response:{headers:{add:{ok:'{{body.ok}}'}},body_formats:['json']}})).ok).toBe(true);
    expect(parseNormalizeCompileAggregate(aggregate({response:{headers:{add:{ok:'{{request.body.ok}}'}}}})).ok).toBe(true);
    expect(parseNormalizeCompileAggregate(aggregate({}, {condition:'{{response.body.ok}}'})).ok).toBe(false);
    expect(parseNormalizeCompileAggregate(aggregate({response:{body_formats:['json','json']}})).ok).toBe(false);
  });
});
