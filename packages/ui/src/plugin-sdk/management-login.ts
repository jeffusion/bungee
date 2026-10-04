/** Host-owned management login capability provided to a plugin login page. */
export interface ManagementLoginContext {
  readonly provider: Readonly<{ name: string; publicOrigin: string }>;
  login(input: unknown): Promise<unknown>;
  complete(): Promise<void>;
}

/** Recognizes an operation invalidated by a newer login, logout, mode, or page lifetime. */
export function isManagementLoginStaleError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && (error as { code?: unknown }).code === 'management_login_stale';
}
