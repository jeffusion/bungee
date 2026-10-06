/**
 * Worker-side entry of the channel-probe cross fixture: a real no-op plugin while
 * `control.ts` owns both consumes (one same-process, one across the peer).
 */

export class ChannelProbeCross {
  static readonly name = 'channel-probe-cross';
  static readonly version = '1.0.0';

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config: Record<string, unknown> = {}) {}

  register(): void {}
  async onDestroy(): Promise<void> {}
}

export default ChannelProbeCross;
