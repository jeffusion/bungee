import { describe, it, expect } from 'bun:test';
import type { Endpoint } from '@jeffusion/bungee-types';
import {
  buildFinalUpstreamFinallyContext,
  buildRequestLevelFinallyContext,
  cloneMutableRequestContext,
  joinPaths,
  rebaseToUpstream,
  type MutableRequestContext,
} from '../../src/worker/request/context';

describe('phase context utilities', () => {
  describe('cloneMutableRequestContext', () => {
    it('deep clones independently mutable request context fields', () => {
      const original: MutableRequestContext = {
        url: new URL('http://gateway.local/v1/chat?model=test'),
        method: 'POST',
        headers: {
          authorization: 'Bearer original',
          'content-type': 'application/json',
        },
        body: {
          messages: [{ role: 'user', content: 'hello' }],
          options: { temperature: 0.2 },
        },
        query: {
          model: 'test',
          stream: 'false',
        },
        routeId: 'route-chat',
      };

      const clone = cloneMutableRequestContext(original);

      expect(clone).not.toBe(original);
      expect(clone.url).not.toBe(original.url);
      expect(clone.headers).not.toBe(original.headers);
      expect(clone.body).not.toBe(original.body);
      expect(clone.query).not.toBe(original.query);

      expect(clone.url.pathname).toBe('/v1/chat');
      expect(clone.url.search).toBe('?model=test');
      expect(clone.method).toBe('POST');
      expect(clone.headers.authorization).toBe('Bearer original');

      clone.url.pathname = '/v1/embeddings';
      clone.headers.authorization = 'Bearer clone';
      clone.body.messages[0].content = 'changed';
      clone.query.model = 'other';

      expect(original.url.pathname).toBe('/v1/chat');
      expect(original.headers.authorization).toBe('Bearer original');
      expect(original.body.messages[0].content).toBe('hello');
      expect(original.query?.model).toBe('test');
    });
  });

  describe('rebaseToUpstream', () => {
    it('rebases URL origin and path while preserving query string and setting upstreamId', () => {
      const ctx: MutableRequestContext = {
        url: new URL('http://gateway.local/v1/chat?model=test&stream=false'),
        method: 'POST',
        headers: { authorization: 'Bearer token' },
        body: { prompt: 'hello' },
        query: { model: 'test', stream: 'false' },
      };
      const upstream: Endpoint = {
        id: 'primary-openai',
        target: 'https://api.openai.com:8443/api',
      };

      rebaseToUpstream(ctx, upstream);

      expect(ctx.url.protocol).toBe('https:');
      expect(ctx.url.hostname).toBe('api.openai.com');
      expect(ctx.url.port).toBe('8443');
      expect(ctx.url.pathname).toBe('/api/v1/chat');
      expect(ctx.url.search).toBe('?model=test&stream=false');
      expect(ctx.query).toEqual({ model: 'test', stream: 'false' });
      expect(ctx.upstreamId).toBe('primary-openai');
    });

    it('uses upstream target as upstreamId when id is absent', () => {
      const ctx: MutableRequestContext = {
        url: new URL('http://gateway.local/chat'),
        method: 'GET',
        headers: {},
      };
      const upstream: Endpoint = { target: 'http://fallback.local/base' };

      rebaseToUpstream(ctx, upstream);

      expect(ctx.upstreamId).toBe('http://fallback.local/base');
    });
  });

  describe('joinPaths', () => {
  it.each([
    ['/api', '/v1/chat', '/api/v1/chat'],
    ['/api/', '/v1/chat', '/api/v1/chat'],
    ['/api', 'v1/chat', '/api/v1/chat'],
    ['', '/v1/chat', '/v1/chat'],
    ['/api', '', '/api'],
    ['/', '/', '/'],
    ['/api//', '//v1', '/api/v1'],
    ['//', '/', '/'],
    ['/a///b', '/c//d', '/a/b/c/d'],
  ])('joins %p and %p as %p', (base, relative, expected) => {
      const result = joinPaths(base, relative);

      expect(result).toBe(expected);
      expect(result).not.toContain('//');
    });
  });

  describe('buildRequestLevelFinallyContext', () => {
    it('returns request-level finally context with route and service metadata', () => {
      expect(buildRequestLevelFinallyContext('route-chat', 'llm-service')).toEqual({
        phase: 'request-level',
        routeId: 'route-chat',
        serviceName: 'llm-service',
      });
    });
  });

  describe('buildFinalUpstreamFinallyContext', () => {
    it('returns final-upstream-level finally context with route, upstream, and service metadata', () => {
      expect(buildFinalUpstreamFinallyContext('route-chat', 'primary-openai', 'llm-service')).toEqual({
        phase: 'final-upstream-level',
        routeId: 'route-chat',
        upstreamId: 'primary-openai',
        serviceName: 'llm-service',
      });
    });
  });
});
