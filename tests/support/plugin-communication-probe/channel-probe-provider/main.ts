/**
 * Worker-side entry of the channel-probe provider fixture.
 *
 * An activated runtime-scope `global` plugin must be instantiable in the worker as
 * well as in control (the orchestrator refuses an activated global plugin that never
 * starts), so this entry is a real no-op worker plugin while `control.ts` owns the
 * stream / snapshot / event publications.
 */

export class ChannelProbeProvider {
  static readonly name = 'channel-probe-provider';
  static readonly version = '1.0.0';

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config: Record<string, unknown> = {}) {}

  register(): void {}
  async onDestroy(): Promise<void> {}
}

export default ChannelProbeProvider;
