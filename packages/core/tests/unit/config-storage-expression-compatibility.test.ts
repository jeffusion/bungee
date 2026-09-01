import { describe, expect, test } from 'bun:test';
import { parseNormalizeCompile } from '../../src/config-storage';

declare global {
  var __expressionCompileProbe: number;
}

const serviceId = '10000000-0000-4000-8000-000000000010';

function compileExpression(expression: string) {
  return parseNormalizeCompile({
    services: [{
      id: serviceId,
      name: 'expression-service',
      endpoints: [{
        id: '30000000-0000-4000-8000-000000000010',
        target: 'https://example.com',
        condition: `{{ ${expression} }}`,
      }],
    }],
  });
}

describe('configuration expression syntax compatibility', () => {
  test('accepts JavaScript constructs supported by SafeEvaluator', () => {
    const expressions = [
      "body.user?.profile?.name ?? 'anonymous'",
      "({ model: body.model, tags: [method, url.pathname] })",
      "trim(headers['x-name'] ?? '') || toLowerCase(method)",
      'Math.max(parseInt(env.LIMIT ?? "1"), randomInt(1, 2))',
      'JSON.stringify({ id: uuid(), at: now(), digest: sha256(method) })',
      "body.kind === 'a' ? (body.value ? 'x' : 'y') : (stream?.phase ?? 'none')",
      'isFinite(parseFloat(env.RATE ?? "0")) && encodeURIComponent(url.pathname)',
      'first([body.model, last(values(body))])',
      "({ label: 'globalThis', keys: ['constructor', 'prototype'] })",
      '`literal globalThis ${body.model ?? "none"}`',
      '/globalThis|constructor/.test(method)',
      'body.model /* globalThis.constructor */ ?? "none"',
      'body[method] ?? headers[env.HEADER]',
      'body[url.pathname]?.value',
      'body.items.slice(0, 2).includes(body.model)',
      'method.trim().toLowerCase().startsWith("get")',
      'Math.min(1, Math.abs(-2)) + Date.UTC(2026, 0, 1)',
      'Date.parse("2026-01-01T00:00:00Z")',
      'JSON.parse(JSON.stringify({ method })).method',
      'headers.authorization.split(" ")[1]',
      'headers.authorization["split"](" ")[1]',
      'headers.authorization[`split`](" ")[1]',
    ];

    for (const expression of expressions) {
      expect(compileExpression(expression)).toMatchObject({ ok: true });
    }
  });

  test('compiles expressions without invoking them', () => {
    globalThis.__expressionCompileProbe = 0;
    const result = compileExpression(
      "body.enabled ? (globalThis.__expressionCompileProbe = 1) : 'safe'",
    );

    expect(result.ok).toBe(false);
    expect(globalThis.__expressionCompileProbe).toBe(0);
  });

  test('rejects malformed syntax and dangerous global or prototype access', () => {
    const expressions = [
      'body.model ===',
      'process.exit(1)',
      "require('node:fs')",
      "eval('1')",
      "Function('return 1')()",
      'globalThis.value',
      'window.location',
      'global.value',
      'process.env.SECRET',
      'body.constructor.constructor("return globalThis")()',
      'body.__proto__.polluted',
      'body.prototype',
      "body['constructor']",
      'body[`prototype`]',
      '`${globalThis.value}`',
      'global\\u0054his.value',
    ];

    for (const expression of expressions) {
      const result = compileExpression(expression);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some(({ code }) => code === 'invalid_expression')).toBe(true);
      }
    }
  });

  test('rejects computed constructor and indirect global escape variants', () => {
    const expressions = [
      'body["con"+"structor"]["con"+"structor"]("return process")()',
      '(0, eval)("this")',
      'Reflect.get(Object, "constructor")("return globalThis")()',
      'body[`con${"structor"}`]["constructor"]("return globalThis")()',
      'body["__" + "proto__"]',
      'Object.getOwnPropertyDescriptor(body, "constructor")',
      '(Function)("return process")()',
      'globalThis["pro" + "cess"]',
      '(body.model, method)',
      'fetch("https://example.com")',
      'Bun.file("/etc/passwd")',
      'import("node:fs")',
      'crypto',
      'performance.now()',
      'setTimeout(() => 1, 0)',
      'body["\\x63onstructor"]',
      'body["\\u0063onstructor"]',
      'body["\\u{63}onstructor"]',
      'body["con" + "structor"]',
      '(0, eval)("this")',
      '(0, Function)("return globalThis")()',
      'new URL("https://example.com")',
      'Math[body.method](1)',
      'body[method]()',
    ];

    for (const expression of expressions) {
      const result = compileExpression(expression);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some(({ code }) => code === 'invalid_expression')).toBe(true);
      }
    }
  });

  test('rejects mutating, indirect, and unknown member calls', () => {
    const expressions = [
      'body[body.key].push(1)',
      'body.items.sort()',
      'body.items.splice(0, 1)',
      'body.items.reverse()',
      'body.items.fill(1)',
      'body.items.copyWithin(0, 1)',
      'body.items.pop()',
      'body.items.shift()',
      'body.items.unshift(1)',
      'body.method.call(null)',
      'body.method.apply(null, [])',
      'body.method.bind(null)',
      'body.method.call.call(null)',
      'Math.max.call(null, 1, 2)',
      'JSON.stringify.apply(null, [body])',
      'body.items.unknownMethod()',
      'Math.unknownMethod(1)',
      'JSON.unknownMethod(body)',
      '/x/.exec(method)',
    ];

    for (const expression of expressions) {
      const result = compileExpression(expression);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some(({ code }) => code === 'invalid_expression')).toBe(true);
      }
    }
  });
});
