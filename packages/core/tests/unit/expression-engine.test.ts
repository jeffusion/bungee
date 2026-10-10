import { describe, test, expect, beforeEach } from 'bun:test';
import {
  processDynamicValue,
  evaluateExpression,
  clearExpressionCache,
  type ExpressionContext
} from '../../src/expression-engine';

describe('Expression Engine', () => {
  let mockContext: ExpressionContext;

  beforeEach(() => {
    clearExpressionCache();
    mockContext = {
      headers: {
        'authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
        'user-agent': 'Mozilla/5.0',
        'host': 'api.example.com',
        'x-forwarded-for': ' 192.168.1.1 , 10.0.0.1 ',
      },
      body: {
        api_version: 'v1',
        user_id: '12345',
        session_id: 'abc123',
      },
      url: {
        pathname: '/api/test',
        search: '?param=value',
        host: 'api.example.com',
        protocol: 'https:',
      },
      method: 'POST',
      env: {
        NODE_ENV: 'production',
        API_KEY: 'secret-key',
      },
    };
  });

  describe('Basic Expression Evaluation', () => {
    test('should evaluate simple variable access', () => {
      expect(evaluateExpression('headers.host', mockContext)).toBe('api.example.com');
      expect(evaluateExpression('method', mockContext)).toBe('POST');
      expect(evaluateExpression('body.user_id', mockContext)).toBe('12345');
    });

    test('should evaluate built-in functions', () => {
      const result1 = evaluateExpression('uuid()', mockContext);
      expect(typeof result1).toBe('string');
      expect(result1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      const result2 = evaluateExpression('now()', mockContext);
      expect(typeof result2).toBe('number');
      expect(result2).toBeGreaterThan(1600000000000);
    });

    test('should evaluate string operations', () => {
      expect(evaluateExpression('base64encode("hello")', mockContext)).toBe('aGVsbG8=');
      expect(evaluateExpression('base64decode("aGVsbG8=")', mockContext)).toBe('hello');
      expect(evaluateExpression('md5("test")', mockContext)).toBe('098f6bcd4621d373cade4e832627b4f6');
    });

    test('should evaluate JWT parsing', () => {
      const result = evaluateExpression('parseJWT(headers.authorization.split(" ")[1])', mockContext);
      expect(result).toEqual({
        sub: '1234567890',
        name: 'John Doe',
        iat: 1516239022,
      });
    });
  });

  describe('Function Call Operations', () => {
    test('should handle simple function calls', () => {
      expect(evaluateExpression('toLowerCase(headers["user-agent"])', mockContext)).toBe('mozilla/5.0');
      expect(evaluateExpression('trim("  hello  ")', mockContext)).toBe('hello');
    });

    test('should handle complex nested function calls', () => {
      const result = evaluateExpression('trim(first(split(headers["x-forwarded-for"], ",")))', mockContext);
      expect(result).toBe('192.168.1.1');
    });

    test('should handle JWT parsing with function calls', () => {
      const result = evaluateExpression('parseJWT(last(split(headers.authorization, " ")))', mockContext);
      expect(result.sub).toBe('1234567890');
    });
  });

  describe('Conditional Expressions', () => {
    test('should handle ternary operators', () => {
      expect(evaluateExpression('headers.host === "api.example.com" ? "production" : "development"', mockContext))
        .toBe('production');

      expect(evaluateExpression('body.api_version === "v2" ? "new" : "old"', mockContext))
        .toBe('old');
    });

    test('should handle logical operators', () => {
      expect(evaluateExpression('body.user_id || "anonymous"', mockContext)).toBe('12345');
      expect(evaluateExpression('body.missing_field || "default"', mockContext)).toBe('default');
      expect(evaluateExpression('headers.host && headers.host.includes("example")', mockContext)).toBe(true);
    });
  });

  describe('Complex Expressions', () => {
    test('should handle nested function calls', () => {
      const result = evaluateExpression('base64encode(jsonStringify({user: body.user_id, time: now()}))', mockContext);
      const decoded = JSON.parse(Buffer.from(result, 'base64').toString());
      expect(decoded.user).toBe('12345');
      expect(typeof decoded.time).toBe('number');
    });

    test('should handle array operations', () => {
      expect(evaluateExpression('length(split(headers["user-agent"], "/"))', mockContext)).toBe(2);
      expect(evaluateExpression('length(keys(body))', mockContext)).toBe(3);
    });
  });

  describe('Dynamic Value Processing', () => {
    test('should return static values unchanged', () => {
      expect(processDynamicValue('static-value', mockContext)).toBe('static-value');
      expect(processDynamicValue(42, mockContext)).toBe(42);
      expect(processDynamicValue(true, mockContext)).toBe(true);
    });

    test('should process single expressions', () => {
      expect(processDynamicValue('{{headers.host}}', mockContext)).toBe('api.example.com');
      expect(processDynamicValue('{{now()}}', mockContext)).toBeTypeOf('number');
      expect(processDynamicValue('{{uuid()}}', mockContext)).toMatch(/^[0-9a-f-]{36}$/);
    });

    test('should process template strings with multiple expressions', () => {
      const result = processDynamicValue('Request from {{headers.host}} using {{method}}', mockContext);
      expect(result).toBe('Request from api.example.com using POST');
    });

    test('should handle mixed content', () => {
      const result = processDynamicValue('user-{{body.user_id}}-{{now()}}-suffix', mockContext);
      expect(result).toMatch(/^user-12345-\d+-suffix$/);
    });

    test('should handle expression errors gracefully', () => {
      // 表达式错误应该抛出异常，而不是保持原值
      expect(() => processDynamicValue('{{headers.nonexistent.invalid}}', mockContext)).toThrow();

      // 但是对于逻辑运算，undefined 应该正常处理
      const result = processDynamicValue('{{headers.missing || "default"}}', mockContext);
      expect(result).toBe('default');
    });
  });

  describe('Security and Error Handling', () => {
    test('should prevent access to dangerous functions', () => {
      expect(() => evaluateExpression('require("fs")', mockContext)).toThrow();
      expect(() => evaluateExpression('process.exit()', mockContext)).toThrow();
      expect(() => evaluateExpression('eval("console.log()")', mockContext)).toThrow();
    });

    test('should handle timeout for infinite loops', () => {
      expect(() => evaluateExpression('while(true) {}', mockContext)).toThrow();
    });

    test('should handle undefined access gracefully', () => {
      expect(evaluateExpression('headers.nonexistent || "default"', mockContext)).toBe('default');
      expect(evaluateExpression('body.missing?.nested?.prop || "fallback"', mockContext)).toBe('fallback');
    });
  });

  describe('Type Conversions', () => {
    test('should handle number conversions', () => {
      expect(evaluateExpression('parseInt("123")', mockContext)).toBe(123);
      expect(evaluateExpression('parseFloat("123.45")', mockContext)).toBe(123.45);
    });

    test('should handle JSON operations', () => {
      const obj = { test: 'value' };
      expect(evaluateExpression('jsonParse(\'{"test":"value"}\')', mockContext)).toEqual(obj);
      expect(evaluateExpression('jsonStringify({test: "value"})', mockContext)).toBe('{"test":"value"}');
    });
  });

  describe('Built-in Function Coverage', () => {
    test('should test random functions', () => {
      const result = evaluateExpression('randomInt(1, 10)', mockContext);
      expect(result).toBeGreaterThanOrEqual(1);
      expect(result).toBeLessThanOrEqual(10);
    });

    test('should test encryption functions', () => {
      expect(evaluateExpression('encrypt("test", "base64")', mockContext)).toBe('dGVzdA==');
    });

    test('should test array utilities', () => {
      mockContext.body.testArray = ['a', 'b', 'c'];
      expect(evaluateExpression('first(body.testArray)', mockContext)).toBe('a');
      expect(evaluateExpression('last(body.testArray)', mockContext)).toBe('c');
    });

    test('should test string utilities', () => {
      expect(evaluateExpression('toUpperCase("hello")', mockContext)).toBe('HELLO');
      expect(evaluateExpression('replace("hello world", "world", "universe")', mockContext)).toBe('hello universe');
    });

    test('should test type checking', () => {
      expect(evaluateExpression('isString("test")', mockContext)).toBe(true);
      expect(evaluateExpression('isNumber(123)', mockContext)).toBe(true);
      expect(evaluateExpression('isArray([])', mockContext)).toBe(true);
      expect(evaluateExpression('isObject({})', mockContext)).toBe(true);
    });
  });
});