import type { BoundControlClient, ControlBindingIdentity } from '../plugin-control/contracts';

export type BoundControlAttemptIdentity = {
  readonly revision: number;
  readonly endpointId: string;
  readonly attemptId: string;
};

export type BoundControlClientProvider = (
  binding: ControlBindingIdentity,
  attempt?: BoundControlAttemptIdentity,
) => BoundControlClient;

let provider: BoundControlClientProvider | null = null;

export function setBoundControlClientProvider(next: BoundControlClientProvider | null): void {
  provider = next;
}

export function getBoundControlClient(
  binding: ControlBindingIdentity,
  attempt?: BoundControlAttemptIdentity,
): BoundControlClient {
  if (provider === null) throw new Error('bound control client provider is unavailable');
  return provider(binding, attempt);
}

export function hasBoundControlClientProvider(): boolean {
  return provider !== null;
}
