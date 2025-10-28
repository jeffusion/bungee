import { loadConfig } from '../../config';
import { authenticateRequest } from '../../auth';
import { logger } from '../../logger';

/**
 * 登录请求接口
 */
export interface LoginRequest {
  token: string;
}

/**
 * 登录响应接口
 */
export interface LoginResponse {
  success: boolean;
  error?: string;
}

/**
 * Auth Handler
 * 处理 UI 认证相关的 API 请求
 */
export class AuthHandler {
  /**
   * 登录接口
   * 验证用户提供的 token 是否在配置的 auth.tokens 列表中
   */
  static async login(req: Request): Promise<Response> {
    try {
      // 1. 解析请求体
      const body = await req.json() as LoginRequest;
      const { token } = body;

      if (!token || typeof token !== 'string' || token.trim() === '') {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Token is required'
          } as LoginResponse),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // 2. 获取配置
      const config = await loadConfig();

      // 3. 检查是否启用认证
      if (!config.auth?.enabled) {
        // 如果认证未启用，直接返回成功
        return new Response(
          JSON.stringify({ success: true } as LoginResponse),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      // 4. 构造一个临时请求对象用于验证
      const tempReq = new Request(req.url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      // 5. 使用现有的 authenticateRequest 函数验证 token
      const context = {
        env: process.env,
        request: {},
        headers: {},
        query: {}
      };

      const authResult = await authenticateRequest(tempReq, config.auth, context);

      // 6. 返回验证结果
      if (authResult.success) {
        logger.info({ url: req.url }, 'UI login successful');
        return new Response(
          JSON.stringify({ success: true } as LoginResponse),
          { headers: { 'Content-Type': 'application/json' } }
        );
      } else {
        logger.warn({ url: req.url, error: authResult.error }, 'UI login failed');
        return new Response(
          JSON.stringify({
            success: false,
            error: authResult.error || 'Invalid token'
          } as LoginResponse),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        );
      }
    } catch (error: any) {
      logger.error({ error, url: req.url }, 'Login error');
      return new Response(
        JSON.stringify({
          success: false,
          error: error.message || 'Internal server error'
        } as LoginResponse),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  /**
   * 验证接口（可选）
   * 验证当前 token 是否有效
   */
  static async verify(req: Request): Promise<Response> {
    try {
      // 1. 获取配置
      const config = await loadConfig();

      // 2. 检查是否启用认证
      if (!config.auth?.enabled) {
        return new Response(
          JSON.stringify({ success: true } as LoginResponse),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      // 3. 验证 Authorization header
      const context = {
        env: process.env,
        request: {},
        headers: {},
        query: {}
      };

      const authResult = await authenticateRequest(req, config.auth, context);

      // 4. 返回验证结果
      if (authResult.success) {
        return new Response(
          JSON.stringify({ success: true } as LoginResponse),
          { headers: { 'Content-Type': 'application/json' } }
        );
      } else {
        return new Response(
          JSON.stringify({
            success: false,
            error: authResult.error || 'Invalid token'
          } as LoginResponse),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        );
      }
    } catch (error: any) {
      logger.error({ error, url: req.url }, 'Token verification error');
      return new Response(
        JSON.stringify({
          success: false,
          error: error.message || 'Internal server error'
        } as LoginResponse),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }
}
