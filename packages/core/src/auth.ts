import { logger } from './logger';
import type { AuthConfig } from '@jeffusion/bungee-shared';
import type { ExpressionContext } from './expression-engine';
import { processDynamicValue } from './expression-engine';

/**
 * 认证结果
 */
export interface AuthResult {
  success: boolean;
  error?: string;
}

/**
 * 从请求中提取认证 token
 * @param req - HTTP 请求对象
 * @returns 提取的 token，如果未找到则返回 null
 */
export function extractToken(req: Request): string | null {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return null;
  }

  // 支持两种格式：
  // 1. "Bearer <token>" - 标准格式
  // 2. "<token>" - 直接 token
  // 过滤空字符串以处理多个空格的情况
  const parts = authHeader.trim().split(' ').filter(p => p.length > 0);

  if (parts.length === 2 && parts[0] === 'Bearer') {
    // 标准格式：Bearer <token>
    return parts[1];
  } else if (parts.length === 1) {
    // 直接 token
    return parts[0];
  }

  return null;
}

/**
 * 恒定时间字符串比较（防止时序攻击）
 * @param a - 字符串 A
 * @param b - 字符串 B
 * @returns 是否相等
 */
export function constantTimeCompare(a: string, b: string): boolean {
  // 如果长度不同，仍然进行完整比较以保持恒定时间
  const aLength = a.length;
  const bLength = b.length;
  const maxLength = Math.max(aLength, bLength);

  let result = aLength === bLength ? 0 : 1;

  for (let i = 0; i < maxLength; i++) {
    const charA = i < aLength ? a.charCodeAt(i) : 0;
    const charB = i < bLength ? b.charCodeAt(i) : 0;
    result |= charA ^ charB;
  }

  return result === 0;
}

/**
 * 认证请求
 * @param req - HTTP 请求对象
 * @param authConfig - 认证配置
 * @param context - 表达式上下文（用于处理环境变量）
 * @returns 认证结果
 */
export async function authenticateRequest(
  req: Request,
  authConfig: AuthConfig,
  context: ExpressionContext
): Promise<AuthResult> {
  // 1. 检查认证是否启用
  if (!authConfig.enabled) {
    return { success: true };
  }

  // 2. 提取 token
  const token = extractToken(req);
  if (!token) {
    return { success: false, error: 'Missing or invalid Authorization header' };
  }

  // 3. 处理配置中的表达式（支持环境变量）
  const validTokens: string[] = [];
  for (const tokenExpr of authConfig.tokens) {
    try {
      const processedToken = processDynamicValue(tokenExpr, context);
      if (typeof processedToken === 'string' && processedToken.trim() !== '') {
        validTokens.push(processedToken);
      } else {
        logger.warn({ tokenExpr }, 'Token expression did not evaluate to a valid string');
      }
    } catch (error) {
      logger.error({ tokenExpr, error }, 'Failed to process token expression');
    }
  }

  if (validTokens.length === 0) {
    logger.error('No valid tokens configured');
    return { success: false, error: 'Authentication configuration error' };
  }

  // 4. 使用恒定时间比较验证 token
  for (const validToken of validTokens) {
    if (constantTimeCompare(token, validToken)) {
      return { success: true };
    }
  }

  return { success: false, error: 'Invalid token' };
}
