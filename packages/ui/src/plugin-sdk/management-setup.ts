/** Host-owned initialization capability bound to the selected provider and page lifetime. */
export interface ManagementSetupContext {
  readonly provider: Readonly<{ name: string; publicOrigin: string }>;
  initialize(input: unknown): Promise<void>;
}
