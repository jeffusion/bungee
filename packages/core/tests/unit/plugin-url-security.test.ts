/**
 * Plugin URL Security Tests
 *
 * 测试 PluginUrl 的安全机制，确保：
 * 1. Plugin 可以读取所有 URL 字段
 * 2. Plugin 只能修改白名单字段（pathname, search, hash）
 * 3. Plugin 无法修改只读字段（protocol, host, hostname, port, origin）
 * 4. TypeScript 类型系统提供编译时保护
 * 5. Proxy 提供运行时保护
 */

import { describe, it, expect, beforeEach, jest } from 'bun:test';
import { createPluginUrl } from '../../src/worker/plugin/url-adapter';

describe('PluginUrl Security', () => {
  let testUrl: URL;

  beforeEach(() => {
    // 使用非默认端口（8443）以便测试端口字段
    testUrl = new URL('https://api.example.com:8443/v1/messages?foo=bar#section');
  });

  describe('Reading URL fields', () => {
    it('should allow reading all URL fields', () => {
      const pluginUrl = createPluginUrl(testUrl);

      // 可读取所有字段
      expect(pluginUrl.protocol).toBe('https:');
      expect(pluginUrl.host).toBe('api.example.com:8443');
      expect(pluginUrl.hostname).toBe('api.example.com');
      expect(pluginUrl.port).toBe('8443');
      expect(pluginUrl.pathname).toBe('/v1/messages');
      expect(pluginUrl.search).toBe('?foo=bar');
      expect(pluginUrl.hash).toBe('#section');
      expect(pluginUrl.href).toBe('https://api.example.com:8443/v1/messages?foo=bar#section');
      expect(pluginUrl.origin).toBe('https://api.example.com:8443');
    });

    it('should return consistent values across multiple reads', () => {
      const pluginUrl = createPluginUrl(testUrl);

      // 多次读取应该返回相同的值
      expect(pluginUrl.host).toBe(pluginUrl.host);
      expect(pluginUrl.pathname).toBe(pluginUrl.pathname);
    });
  });

  describe('Modifying white-listed fields', () => {
    it('should allow modifying pathname', () => {
      const pluginUrl = createPluginUrl(testUrl);

      pluginUrl.pathname = '/v1/chat/completions';

      const modifications = pluginUrl.getModifiedFields();
      expect(modifications.pathname).toBe('/v1/chat/completions');
    });

    it('should allow modifying search', () => {
      const pluginUrl = createPluginUrl(testUrl);

      pluginUrl.search = '?stream=true';

      const modifications = pluginUrl.getModifiedFields();
      expect(modifications.search).toBe('?stream=true');
    });

    it('should allow modifying hash', () => {
      const pluginUrl = createPluginUrl(testUrl);

      pluginUrl.hash = '#test';

      const modifications = pluginUrl.getModifiedFields();
      expect(modifications.hash).toBe('#test');
    });

    it('should allow modifying all white-listed fields together', () => {
      const pluginUrl = createPluginUrl(testUrl);

      pluginUrl.pathname = '/new/path';
      pluginUrl.search = '?new=query';
      pluginUrl.hash = '#new-hash';

      const modifications = pluginUrl.getModifiedFields();
      expect(modifications.pathname).toBe('/new/path');
      expect(modifications.search).toBe('?new=query');
      expect(modifications.hash).toBe('#new-hash');
    });

    it('should return modified values when reading', () => {
      const pluginUrl = createPluginUrl(testUrl);

      pluginUrl.pathname = '/modified/path';

      // 读取应该返回修改后的值
      expect(pluginUrl.pathname).toBe('/modified/path');
    });
  });

  describe('Blocking modifications to readonly fields', () => {
    it('should block modifying protocol', () => {
      const pluginUrl = createPluginUrl(testUrl);

      // 尝试修改 protocol
      const result = Reflect.set(pluginUrl, 'protocol', 'http:');

      // 应该被阻止
      expect(result).toBe(false);
      expect(pluginUrl.protocol).toBe('https:');
    });

    it('should block modifying host', () => {
      const pluginUrl = createPluginUrl(testUrl);

      // 尝试修改 host
      const result = Reflect.set(pluginUrl, 'host', 'evil.com');

      // 应该被阻止
      expect(result).toBe(false);
      expect(pluginUrl.host).toBe('api.example.com:8443');
    });

    it('should block modifying hostname', () => {
      const pluginUrl = createPluginUrl(testUrl);

      // 尝试修改 hostname
      const result = Reflect.set(pluginUrl, 'hostname', 'evil.com');

      // 应该被阻止
      expect(result).toBe(false);
      expect(pluginUrl.hostname).toBe('api.example.com');
    });

    it('should block modifying port', () => {
      const pluginUrl = createPluginUrl(testUrl);

      // 尝试修改 port
      const result = Reflect.set(pluginUrl, 'port', '8080');

      // 应该被阻止
      expect(result).toBe(false);
      expect(pluginUrl.port).toBe('8443');
    });

    it('should block modifying href', () => {
      const pluginUrl = createPluginUrl(testUrl);

      // 尝试修改 href
      const result = Reflect.set(pluginUrl, 'href', 'http://evil.com/bad');

      // 应该被阻止
      expect(result).toBe(false);
      expect(pluginUrl.href).toBe('https://api.example.com:8443/v1/messages?foo=bar#section');
    });

    it('should block modifying origin', () => {
      const pluginUrl = createPluginUrl(testUrl);

      // 尝试修改 origin
      const result = Reflect.set(pluginUrl, 'origin', 'http://evil.com');

      // 应该被阻止
      expect(result).toBe(false);
      expect(pluginUrl.origin).toBe('https://api.example.com:8443');
    });
  });

  describe('getModifiedFields() method', () => {
    it('should return initial values when no modifications made', () => {
      const pluginUrl = createPluginUrl(testUrl);

      const modifications = pluginUrl.getModifiedFields();

      expect(modifications.pathname).toBe('/v1/messages');
      expect(modifications.search).toBe('?foo=bar');
      expect(modifications.hash).toBe('#section');
    });

    it('should return a new object each time (not a reference)', () => {
      const pluginUrl = createPluginUrl(testUrl);

      const mods1 = pluginUrl.getModifiedFields();
      const mods2 = pluginUrl.getModifiedFields();

      // 应该是不同的对象
      expect(mods1).not.toBe(mods2);
      // 但内容相同
      expect(mods1).toEqual(mods2);
    });

    it('should not allow modifying the returned object to affect the original', () => {
      const pluginUrl = createPluginUrl(testUrl);

      const mods = pluginUrl.getModifiedFields();
      mods.pathname = '/hacked';

      // 应该不影响原始值
      expect(pluginUrl.pathname).toBe('/v1/messages');
      expect(pluginUrl.getModifiedFields().pathname).toBe('/v1/messages');
    });
  });

  describe('Isolation between instances', () => {
    it('should create independent instances', () => {
      const pluginUrl1 = createPluginUrl(testUrl);
      const pluginUrl2 = createPluginUrl(testUrl);

      // 修改第一个实例
      pluginUrl1.pathname = '/path1';

      // 不应该影响第二个实例
      expect(pluginUrl2.pathname).toBe('/v1/messages');
    });

    it('should not share modification state', () => {
      const pluginUrl1 = createPluginUrl(testUrl);
      const pluginUrl2 = createPluginUrl(testUrl);

      pluginUrl1.pathname = '/path1';
      pluginUrl2.pathname = '/path2';

      expect(pluginUrl1.getModifiedFields().pathname).toBe('/path1');
      expect(pluginUrl2.getModifiedFields().pathname).toBe('/path2');
    });
  });

  describe('Edge cases', () => {
    it('should handle URL without port', () => {
      const url = new URL('https://api.example.com/v1/messages');
      const pluginUrl = createPluginUrl(url);

      expect(pluginUrl.host).toBe('api.example.com');
      expect(pluginUrl.port).toBe('');
    });

    it('should handle URL without search', () => {
      const url = new URL('https://api.example.com/v1/messages');
      const pluginUrl = createPluginUrl(url);

      expect(pluginUrl.search).toBe('');

      pluginUrl.search = '?foo=bar';
      expect(pluginUrl.getModifiedFields().search).toBe('?foo=bar');
    });

    it('should handle URL without hash', () => {
      const url = new URL('https://api.example.com/v1/messages');
      const pluginUrl = createPluginUrl(url);

      expect(pluginUrl.hash).toBe('');

      pluginUrl.hash = '#section';
      expect(pluginUrl.getModifiedFields().hash).toBe('#section');
    });

    it('should handle empty pathname', () => {
      const url = new URL('https://api.example.com');
      const pluginUrl = createPluginUrl(url);

      expect(pluginUrl.pathname).toBe('/');
    });
  });

  describe('TypeScript type safety (compile-time)', () => {
    it('should allow reading readonly fields with correct types', () => {
      const pluginUrl = createPluginUrl(testUrl);

      // 这些应该编译通过
      const protocol: string = pluginUrl.protocol;
      const host: string = pluginUrl.host;
      const hostname: string = pluginUrl.hostname;
      const port: string = pluginUrl.port;
      const href: string = pluginUrl.href;
      const origin: string = pluginUrl.origin;

      expect(typeof protocol).toBe('string');
      expect(typeof host).toBe('string');
      expect(typeof hostname).toBe('string');
      expect(typeof port).toBe('string');
      expect(typeof href).toBe('string');
      expect(typeof origin).toBe('string');
    });

    it('should allow modifying writable fields with correct types', () => {
      const pluginUrl = createPluginUrl(testUrl);

      // 这些应该编译通过
      pluginUrl.pathname = '/new/path';
      pluginUrl.search = '?new=query';
      pluginUrl.hash = '#new-hash';

      expect(pluginUrl.pathname).toBe('/new/path');
      expect(pluginUrl.search).toBe('?new=query');
      expect(pluginUrl.hash).toBe('#new-hash');
    });
  });
});
