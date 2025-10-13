import type { Upstream } from '../api/routes';
import type { ValidationError } from './route-validator';
import { TransformersAPI } from '../api/transformers';

let cachedTransformers: string[] | null = null;

/**
 * 获取可用的transformers列表（带缓存）
 */
async function getAvailableTransformers(): Promise<string[]> {
  if (cachedTransformers === null) {
    try {
      cachedTransformers = await TransformersAPI.getAll();
    } catch (error) {
      console.warn('Failed to fetch transformers from API, using fallback:', error);
      // 如果API失败，使用fallback列表
      cachedTransformers = ['openai-to-anthropic', 'anthropic-to-openai', 'anthropic-to-gemini'];
    }
  }
  return cachedTransformers;
}

/**
 * 清除transformers缓存（用于刷新时重新获取）
 */
export function clearTransformersCache(): void {
  cachedTransformers = null;
}

/**
 * 同步验证上游配置（不包含transformer验证）
 * 用于响应式语句中的实时验证
 */
export function validateUpstreamSync(upstream: Partial<Upstream>, index: number): ValidationError[] {
  const errors: ValidationError[] = [];
  const prefix = `upstreams[${index}]`;

  // 验证 target
  if (!upstream.target) {
    errors.push({
      field: `${prefix}.target`,
      message: 'Target URL is required'
    });
  } else {
    try {
      const url = new URL(upstream.target);
      if (!['http:', 'https:'].includes(url.protocol)) {
        errors.push({
          field: `${prefix}.target`,
          message: 'Target must use http or https protocol'
        });
      }
    } catch {
      errors.push({
        field: `${prefix}.target`,
        message: 'Invalid URL format'
      });
    }
  }

  // 验证 weight
  if (upstream.weight !== undefined) {
    if (typeof upstream.weight !== 'number' || upstream.weight <= 0) {
      errors.push({
        field: `${prefix}.weight`,
        message: 'Weight must be a positive number'
      });
    }
  }

  // 验证 priority
  if (upstream.priority !== undefined) {
    if (typeof upstream.priority !== 'number' || upstream.priority < 0) {
      errors.push({
        field: `${prefix}.priority`,
        message: 'Priority must be a non-negative number'
      });
    }
  }

  // 注意：此处跳过transformer验证，因为它需要异步API调用
  // transformer验证将在RouteEditor的异步验证中处理

  return errors;
}

/**
 * 验证负载均衡权重总和
 */
export function validateWeights(upstreams: Upstream[]): ValidationError[] {
  const errors: ValidationError[] = [];

  const hasWeights = upstreams.some(u => u.weight !== undefined);
  if (hasWeights) {
    const totalWeight = upstreams.reduce((sum, u) => sum + (u.weight || 0), 0);
    if (totalWeight === 0) {
      errors.push({
        field: 'upstreams',
        message: 'Total weight must be greater than 0'
      });
    }
  }

  return errors;
}

/**
 * 完整的异步验证上游配置（包含transformer验证）
 * 用于RouteEditor的完整验证流程
 */
export async function validateUpstream(upstream: Partial<Upstream>, index: number): Promise<ValidationError[]> {
  // 首先执行同步验证
  const errors = validateUpstreamSync(upstream, index);
  const prefix = `upstreams[${index}]`;

  // 添加transformer的异步验证
  if (upstream.transformer) {
    if (typeof upstream.transformer === 'string') {
      try {
        const availableTransformers = await getAvailableTransformers();
        if (!availableTransformers.includes(upstream.transformer)) {
          errors.push({
            field: `${prefix}.transformer`,
            message: `Unknown transformer: ${upstream.transformer}. Valid options: ${availableTransformers.join(', ')}`
          });
        }
      } catch (error) {
        console.warn('Failed to validate transformer:', error);
        // 如果API失败，不添加验证错误，让其通过
      }
    }
    // 如果是对象，这里可以添加更详细的验证
  }

  return errors;
}
