import { api } from './client';

/**
 * Login request interface
 */
export interface LoginRequest {
  token: string;
}

/**
 * Login response interface
 */
export interface LoginResponse {
  success: boolean;
  error?: string;
}

/**
 * Login with token
 * Calls the backend login API to verify the token
 *
 * @param token - The authentication token to verify
 * @returns Login response indicating success or failure
 *
 * @example
 * ```typescript
 * try {
 *   const result = await loginWithToken('my-secret-token');
 *   if (result.success) {
 *     console.log('Login successful');
 *   } else {
 *     console.error('Login failed:', result.error);
 *   }
 * } catch (error) {
 *   console.error('Login error:', error);
 * }
 * ```
 */
export async function loginWithToken(token: string): Promise<LoginResponse> {
  return api.post<LoginResponse>('/auth/login', { token });
}

/**
 * Verify current token
 * Checks if the current token is still valid
 *
 * @returns Verification response indicating if token is valid
 *
 * @example
 * ```typescript
 * try {
 *   const result = await verifyToken();
 *   if (result.success) {
 *     console.log('Token is valid');
 *   } else {
 *     console.log('Token is invalid');
 *   }
 * } catch (error) {
 *   console.error('Verification error:', error);
 * }
 * ```
 */
export async function verifyToken(): Promise<LoginResponse> {
  return api.get<LoginResponse>('/auth/verify');
}
