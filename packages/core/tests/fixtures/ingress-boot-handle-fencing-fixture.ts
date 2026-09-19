import type { AdmissionSet } from '../../src/ingress/admission-set';
import { IngressAdmissionRegistry } from '../../src/ingress/admission-registry';
import { IngressSupervisionHttpServer } from '../../src/ingress/supervision-http';
import { deriveSupervisionProcessKey } from '../../src/supervision';

export type RecordedIngressCommand = {
  readonly path: string;
  readonly admissionSequence: number | undefined;
};

export type IngressBootFixture = {
  readonly port: number;
  readonly commands: RecordedIngressCommand[];
  readonly stop: () => Promise<void>;
};

export function startIngressBoot(options: {
  readonly port: number;
  readonly rootKey: Uint8Array;
  readonly instanceId: string;
  readonly processInstanceId: string;
  readonly bootNonce: string;
  readonly seed?: readonly AdmissionSet[];
}): IngressBootFixture {
  const registry = new IngressAdmissionRegistry();
  for (const admission of options.seed ?? []) {
    registry.prepare(admission);
    registry.commit(admission);
  }
  const credential = deriveSupervisionProcessKey(
    options.rootKey,
    options.instanceId,
    'ingress',
    options.processInstanceId,
    options.bootNonce,
  );
  const supervision = new IngressSupervisionHttpServer({ credential, registry });
  const commands: RecordedIngressCommand[] = [];
  const listener = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port,
    fetch: async (request) => {
      if (new URL(request.url).pathname === '/__supervision/command') {
        const payload = await request.clone().json() as {
          readonly message?: { readonly path?: unknown };
          readonly body?: { readonly admission_sequence?: unknown };
        };
        if (typeof payload.message?.path === 'string') {
          commands.push({
            path: payload.message.path,
            admissionSequence: typeof payload.body?.admission_sequence === 'number'
              ? payload.body.admission_sequence
              : undefined,
          });
        }
      }
      return supervision.fetch(request);
    },
  });
  if (listener.port === undefined) {
    supervision.stop();
    listener.stop(true);
    throw new Error('ingress fixture did not bind a loopback port');
  }
  return {
    port: listener.port,
    commands,
    stop: async () => {
      supervision.stop();
      await listener.stop(true);
    },
  };
}
