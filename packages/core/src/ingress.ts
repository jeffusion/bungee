#!/usr/bin/env bun

import { importSupervisionCredential } from './supervision';
import { ingressOptionsFromEnvironment, startIngressProcess as startIngressRuntimeProcess, type IngressProcessHandle } from './ingress/runtime';

export * from './ingress/index';

export async function startIngressProcess(): Promise<IngressProcessHandle> {
  return startIngressProcessFromEnvironment();
}

export async function startIngressProcessFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): Promise<IngressProcessHandle> {
  const serialized = environment.BUNGEE_INGRESS_CREDENTIAL;
  if (serialized === undefined) throw new Error('BUNGEE_INGRESS_CREDENTIAL is required');
  const transportSecret = environment.BUNGEE_INGRESS_TRANSPORT_SECRET;
  if (transportSecret === undefined) throw new Error('BUNGEE_INGRESS_TRANSPORT_SECRET is required');
  return startIngressRuntimeProcess(ingressOptionsFromEnvironment(
    importSupervisionCredential(serialized), transportSecret, environment,
  ));
}

let activeIngressProcess: IngressProcessHandle | null = null;
if (import.meta.main) activeIngressProcess = await startIngressProcessFromEnvironment();
