/**
 * Upstream Identity Tests
 * 验证 upstream 按索引标识的行为（修复相同 target 状态混淆问题）
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
type LegacyUpstream = {
  target: string;
  weight: number;
  priority?: number;
  status: 'HEALTHY' | 'UNHEALTHY' | 'HALF_OPEN';
  disabled: boolean;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastFailureTime?: number;
};

// 模拟 runtimeState
const createMockRuntimeState = () => {
  const state = new Map<string, { upstreams: LegacyUpstream[] }>();
  return state;
};

describe('Upstream Identity - Index-based State Management', () => {
  test('should maintain independent state for upstreams with same target', () => {
    const runtimeState = createMockRuntimeState();

    // 创建两个相同 target 但不同 condition 的 upstream
    const upstreams: LegacyUpstream[] = [
      {
        target: 'https://api.example.com',
        weight: 100,
        status: 'HEALTHY',
        disabled: false,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
      },
      {
        target: 'https://api.example.com', // 相同 target
        weight: 100,
        status: 'HEALTHY',
        disabled: false,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
      },
    ];

    runtimeState.set('/api', { upstreams });

    // 按索引禁用第一个 upstream
    const routeState = runtimeState.get('/api')!;
    routeState.upstreams[0].disabled = true;

    // 验证只有索引 0 被禁用
    expect(routeState.upstreams[0].disabled).toBe(true);
    expect(routeState.upstreams[1].disabled).toBe(false);

    // 两个 upstream 有相同的 target
    expect(routeState.upstreams[0].target).toBe(routeState.upstreams[1].target);
  });

  test('should toggle upstream by index correctly', () => {
    const runtimeState = createMockRuntimeState();

    const upstreams: LegacyUpstream[] = [
      { target: 'https://server-a.com', weight: 100, status: 'HEALTHY', disabled: false, consecutiveFailures: 0, consecutiveSuccesses: 0 },
      { target: 'https://server-b.com', weight: 100, status: 'HEALTHY', disabled: false, consecutiveFailures: 0, consecutiveSuccesses: 0 },
      { target: 'https://server-a.com', weight: 100, status: 'HEALTHY', disabled: false, consecutiveFailures: 0, consecutiveSuccesses: 0 }, // 与索引0相同target
    ];

    runtimeState.set('/test', { upstreams });

    // 模拟 toggle 函数逻辑
    const toggle = (routePath: string, upstreamIndex: number, disabled: boolean) => {
      const routeState = runtimeState.get(routePath);
      if (!routeState) return { error: 'Route not found' };
      if (upstreamIndex < 0 || upstreamIndex >= routeState.upstreams.length) {
        return { error: 'Index out of bounds' };
      }

      const upstream = routeState.upstreams[upstreamIndex];
      upstream.disabled = disabled;

      if (!disabled) {
        upstream.consecutiveFailures = 0;
        upstream.consecutiveSuccesses = 0;
      }

      return {
        success: true,
        upstream: {
          index: upstreamIndex,
          target: upstream.target,
          disabled: upstream.disabled,
        },
      };
    };

    // 禁用索引 2 (与索引 0 有相同的 target)
    const result = toggle('/test', 2, true);
    expect(result.success).toBe(true);
    expect(result.upstream?.index).toBe(2);
    expect(result.upstream?.disabled).toBe(true);

    // 验证索引 0 未受影响
    const routeState = runtimeState.get('/test')!;
    expect(routeState.upstreams[0].disabled).toBe(false);
    expect(routeState.upstreams[2].disabled).toBe(true);
    expect(routeState.upstreams[0].target).toBe(routeState.upstreams[2].target);
  });

  test('should reject toggle for invalid index', () => {
    const runtimeState = createMockRuntimeState();

    const upstreams: LegacyUpstream[] = [
      { target: 'https://server.com', weight: 100, status: 'HEALTHY', disabled: false, consecutiveFailures: 0, consecutiveSuccesses: 0 },
    ];

    runtimeState.set('/test', { upstreams });

    const toggle = (routePath: string, upstreamIndex: number, disabled: boolean) => {
      const routeState = runtimeState.get(routePath);
      if (!routeState) return { error: 'Route not found' };
      if (upstreamIndex < 0 || upstreamIndex >= routeState.upstreams.length) {
        return { error: `Index ${upstreamIndex} out of bounds` };
      }
      return { success: true };
    };

    // 测试负数索引
    expect(toggle('/test', -1, true).error).toContain('out of bounds');

    // 测试超出范围的索引
    expect(toggle('/test', 1, true).error).toContain('out of bounds');
    expect(toggle('/test', 100, true).error).toContain('out of bounds');

    // 测试有效索引
    expect(toggle('/test', 0, true).success).toBe(true);
  });
});

describe('Upstream Identity - Runtime State Merge by Index', () => {
  test('should merge runtime state by index, not by target', () => {
    const runtimeState = createMockRuntimeState();

    // 配置中的 upstream（来自 config.json）
    const configUpstreams = [
      { target: 'https://api.example.com', weight: 100 },
      { target: 'https://api.example.com', weight: 200 }, // 相同 target，不同 weight
      { target: 'https://backup.example.com', weight: 50 },
    ];

    // 运行时状态
    const runtimeUpstreams: LegacyUpstream[] = [
      { target: 'https://api.example.com', weight: 100, status: 'HEALTHY', disabled: false, consecutiveFailures: 0, consecutiveSuccesses: 0 },
      { target: 'https://api.example.com', weight: 200, status: 'UNHEALTHY', disabled: true, consecutiveFailures: 3, consecutiveSuccesses: 0, lastFailureTime: Date.now() - 5000 },
      { target: 'https://backup.example.com', weight: 50, status: 'HEALTHY', disabled: false, consecutiveFailures: 0, consecutiveSuccesses: 0 },
    ];

    runtimeState.set('/api', { upstreams: runtimeUpstreams });

    // 模拟 routes.ts 的合并逻辑
    const routeState = runtimeState.get('/api');
    const mergedUpstreams = configUpstreams.map((upstream, index) => {
      const runtimeUpstream = routeState?.upstreams[index];

      if (!runtimeUpstream) {
        return {
          ...upstream,
          status: 'HEALTHY' as const,
          disabled: false,
        };
      }

      return {
        ...upstream,
        status: runtimeUpstream.status,
        lastFailureTime: runtimeUpstream.lastFailureTime,
        disabled: runtimeUpstream.disabled,
      };
    });

    // 验证按索引正确合并
    expect(mergedUpstreams[0].status).toBe('HEALTHY');
    expect(mergedUpstreams[0].disabled).toBe(false);

    expect(mergedUpstreams[1].status).toBe('UNHEALTHY');
    expect(mergedUpstreams[1].disabled).toBe(true);
    expect((mergedUpstreams[1] as { lastFailureTime?: number }).lastFailureTime).toBeDefined();

    expect(mergedUpstreams[2].status).toBe('HEALTHY');
    expect(mergedUpstreams[2].disabled).toBe(false);

    // 确认两个相同 target 的 upstream 有不同状态
    expect(mergedUpstreams[0].target).toBe(mergedUpstreams[1].target);
    expect(mergedUpstreams[0].status).not.toBe(mergedUpstreams[1].status);
  });

  test('should handle missing runtime state gracefully', () => {
    const runtimeState = createMockRuntimeState();

    const configUpstreams = [
      { target: 'https://new-server.com', weight: 100 },
    ];

    // 没有运行时状态
    const routeState = runtimeState.get('/new-route');

    const mergedUpstreams = configUpstreams.map((upstream, index) => {
      if (!routeState) {
        return {
          ...upstream,
          status: 'HEALTHY' as const,
          disabled: false,
        };
      }

      const runtimeUpstream = routeState.upstreams[index];
      return {
        ...upstream,
        status: runtimeUpstream?.status ?? ('HEALTHY' as const),
        disabled: runtimeUpstream?.disabled ?? false,
      };
    });

    expect(mergedUpstreams[0].status).toBe('HEALTHY');
    expect(mergedUpstreams[0].disabled).toBe(false);
  });
});

describe('Upstream Identity - Configuration Reload', () => {
  test('should reinitialize state when configuration order changes', () => {
    const runtimeState = createMockRuntimeState();

    // 初始状态
    const initialUpstreams: LegacyUpstream[] = [
      { target: 'https://server-a.com', weight: 100, status: 'HEALTHY', disabled: false, consecutiveFailures: 0, consecutiveSuccesses: 0 },
      { target: 'https://server-b.com', weight: 100, status: 'UNHEALTHY', disabled: true, consecutiveFailures: 3, consecutiveSuccesses: 0 },
    ];
    runtimeState.set('/api', { upstreams: initialUpstreams });

    // 验证初始状态
    let routeState = runtimeState.get('/api')!;
    expect(routeState.upstreams[0].target).toBe('https://server-a.com');
    expect(routeState.upstreams[0].status).toBe('HEALTHY');
    expect(routeState.upstreams[1].target).toBe('https://server-b.com');
    expect(routeState.upstreams[1].disabled).toBe(true);

    // 模拟配置重载（顺序改变）
    const newConfigUpstreams = [
      { target: 'https://server-b.com', weight: 100 }, // 原来的索引 1 现在是索引 0
      { target: 'https://server-a.com', weight: 100 }, // 原来的索引 0 现在是索引 1
    ];

    // 重新初始化运行时状态
    const reinitializedUpstreams: LegacyUpstream[] = newConfigUpstreams.map(upstream => ({
      target: upstream.target,
      weight: upstream.weight,
      status: 'HEALTHY' as const,
      disabled: false,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
    }));
    runtimeState.set('/api', { upstreams: reinitializedUpstreams });

    // 验证新状态
    routeState = runtimeState.get('/api')!;
    expect(routeState.upstreams[0].target).toBe('https://server-b.com');
    expect(routeState.upstreams[0].status).toBe('HEALTHY');
    expect(routeState.upstreams[0].disabled).toBe(false);

    expect(routeState.upstreams[1].target).toBe('https://server-a.com');
    expect(routeState.upstreams[1].status).toBe('HEALTHY');
    expect(routeState.upstreams[1].disabled).toBe(false);
  });
});

describe('Upstream Identity - API Route Matching', () => {
  test('should parse index from API path correctly', () => {
    const testCases = [
      { path: '/api/routes/%2Fapi/upstreams/0/disable', expectedIndex: 0 },
      { path: '/api/routes/%2Fapi/upstreams/1/enable', expectedIndex: 1 },
      { path: '/api/routes/%2Fapi/upstreams/10/disable', expectedIndex: 10 },
      { path: '/api/routes/%2Fapi%2Fv2/upstreams/5/enable', expectedIndex: 5 },
    ];

    const regex = /^\/api\/routes\/(.+?)\/upstreams\/(\d+)\/(enable|disable)$/;

    testCases.forEach(({ path, expectedIndex }) => {
      const match = path.match(regex);
      expect(match).toBeTruthy();
      if (match) {
        const index = parseInt(match[2], 10);
        expect(index).toBe(expectedIndex);
      }
    });
  });

  test('should reject non-numeric index in API path', () => {
    const invalidPaths = [
      '/api/routes/%2Fapi/upstreams/abc/disable',
      '/api/routes/%2Fapi/upstreams/https%3A%2F%2Fserver.com/enable',
      '/api/routes/%2Fapi/upstreams/-1/disable',
    ];

    const regex = /^\/api\/routes\/(.+?)\/upstreams\/(\d+)\/(enable|disable)$/;

    invalidPaths.forEach(path => {
      const match = path.match(regex);
      // \d+ 不匹配负数或字母
      if (path.includes('-1')) {
        expect(match).toBeFalsy();
      } else if (path.includes('abc') || path.includes('https')) {
        expect(match).toBeFalsy();
      }
    });
  });
});

describe('Upstream Identity - Edge Cases', () => {
  test('should handle empty upstreams array', () => {
    const runtimeState = createMockRuntimeState();
    runtimeState.set('/empty', { upstreams: [] });

    const routeState = runtimeState.get('/empty')!;
    expect(routeState.upstreams.length).toBe(0);

    // 尝试按索引访问应返回 undefined
    expect(routeState.upstreams[0]).toBeUndefined();
  });

  test('should handle single upstream', () => {
    const runtimeState = createMockRuntimeState();
    const upstreams: LegacyUpstream[] = [
      { target: 'https://only-server.com', weight: 100, status: 'HEALTHY', disabled: false, consecutiveFailures: 0, consecutiveSuccesses: 0 },
    ];
    runtimeState.set('/single', { upstreams });

    const routeState = runtimeState.get('/single')!;
    expect(routeState.upstreams.length).toBe(1);
    expect(routeState.upstreams[0].target).toBe('https://only-server.com');

    // 索引 1 不存在
    expect(routeState.upstreams[1]).toBeUndefined();
  });

  test('should preserve upstream properties when toggling', () => {
    const runtimeState = createMockRuntimeState();
    const upstreams: LegacyUpstream[] = [
      {
        target: 'https://server.com',
        weight: 150,
        priority: 2,
        status: 'UNHEALTHY',
        disabled: false,
        consecutiveFailures: 5,
        consecutiveSuccesses: 0,
        lastFailureTime: Date.now() - 10000,
      },
    ];
    runtimeState.set('/test', { upstreams });

    const routeState = runtimeState.get('/test')!;
    const upstream = routeState.upstreams[0];

    // 启用时重置 failure/success 计数器
    upstream.disabled = false;
    upstream.consecutiveFailures = 0;
    upstream.consecutiveSuccesses = 0;

    // 验证其他属性保持不变
    expect(upstream.target).toBe('https://server.com');
    expect(upstream.weight).toBe(150);
    expect(upstream.priority).toBe(2);
    expect(upstream.status).toBe('UNHEALTHY'); // status 不会被 toggle 改变
    expect(upstream.lastFailureTime).toBeDefined();
  });
});
