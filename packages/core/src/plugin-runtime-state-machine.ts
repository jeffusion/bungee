import type { LoadedPluginManifest } from './plugin.types';
import type { PluginScope } from './scoped-plugin-registry';
import {
  PLUGIN_MANIFEST_ENGINE_MISMATCH_ERROR,
  PLUGIN_MANIFEST_SCHEMA_MISMATCH_ERROR,
  PLUGIN_MANIFEST_UNSUPPORTED_CAPABILITY_ERROR,
  type PluginManifestContractSnapshot,
  type PluginManifestValidationFailureCode,
  type PluginManifestValidationError,
} from './plugin-artifact-contract';

export type PluginDiscoveryState = 'undiscovered' | 'discovered';
export type PluginValidationState = 'pending' | 'validated' | 'degraded' | 'quarantined';
export type PluginPersistedEnabledState = 'unknown' | 'enabled' | 'disabled';
export type PluginRuntimeLoadState = 'not-loaded' | 'loaded' | 'degraded' | 'quarantined';
export type PluginScopedServingState = 'non-serving' | 'serving';
export type PluginRuntimeFailureCode = 'runtime-load-failure';
export type PluginFailureStage = 'validation' | 'runtime';
export type PluginFailureClassification = 'degraded' | 'quarantined';
export type PluginLifecycleState =
  | 'undiscovered'
  | 'discovered'
  | 'validated'
  | 'enabled'
  | 'loaded'
  | 'serving'
  | 'disabled'
  | 'degraded'
  | 'quarantined';

export interface PluginRegistryStateSnapshot {
  pluginName: string;
  discovery: PluginDiscoveryState;
  validation: PluginValidationState;
  persistedEnabled: PluginPersistedEnabledState;
  manifest?: LoadedPluginManifest;
  contract?: PluginManifestContractSnapshot;
  failureReason?: string;
}

export interface PluginRuntimeStateSnapshot {
  pluginName: string;
  loadState: PluginRuntimeLoadState;
  servingScopes: PluginScope[];
  failureReason?: string;
  failureCode?: PluginRuntimeFailureCode;
}

export interface PluginFailureSnapshot {
  stage: PluginFailureStage;
  classification: PluginFailureClassification;
  reason: string;
  code?: PluginManifestValidationFailureCode | PluginRuntimeFailureCode;
  generation?: number;
}

export interface FrozenPluginRuntimeState {
  pluginName: string;
  lifecycle: PluginLifecycleState;
  authorities: {
    discovery: 'plugin-registry';
    validation: 'plugin-registry';
    persistedEnabled: 'plugin-registry';
    runtimeLoaded: 'scoped-plugin-registry';
    scopedServing: 'scoped-plugin-registry';
  };
  states: {
    discovery: PluginDiscoveryState;
    validation: PluginValidationState;
    persistedEnabled: PluginPersistedEnabledState;
    runtimeLoaded: PluginRuntimeLoadState;
    scopedServing: PluginScopedServingState;
  };
  runtime: {
    servingScopes: PluginScope[];
    currentGeneration: number | null;
    servingGeneration: number | null;
    drainingGenerations: number[];
  };
  contract: PluginManifestContractSnapshot | null;
  reasons: {
    validation?: string;
    runtime?: string;
  };
  failures: {
    validation?: PluginFailureSnapshot;
    runtime?: PluginFailureSnapshot;
  };
}

export function createPluginRegistryStateSnapshot(
  input: Partial<PluginRegistryStateSnapshot> & Pick<PluginRegistryStateSnapshot, 'pluginName'>,
): PluginRegistryStateSnapshot {
  return {
    pluginName: input.pluginName,
    discovery: input.discovery ?? 'discovered',
    validation: input.validation ?? 'pending',
    persistedEnabled: input.persistedEnabled ?? 'unknown',
    manifest: input.manifest,
    contract: input.contract,
    failureReason: input.failureReason,
  };
}

export function createPluginRuntimeStateSnapshot(
  input: Partial<PluginRuntimeStateSnapshot> & Pick<PluginRuntimeStateSnapshot, 'pluginName'>,
): PluginRuntimeStateSnapshot {
  return {
    pluginName: input.pluginName,
    loadState: input.loadState ?? 'not-loaded',
    servingScopes: input.servingScopes ?? [],
    failureReason: input.failureReason,
    failureCode: input.failureCode,
  };
}

export function classifyPluginValidationFailure(error: unknown): Exclude<PluginValidationState, 'pending' | 'validated'> {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const manifestError = error as PluginManifestValidationError | undefined;
  if (
    manifestError?.details?.validationFailureCode === 'schema-mismatch'
    || manifestError?.details?.validationFailureCode === 'unsupported-capability'
    || manifestError?.details?.validationFailureCode === 'engine-mismatch'
  ) {
    return 'quarantined';
  }
  if (
    message.includes(PLUGIN_MANIFEST_ENGINE_MISMATCH_ERROR)
    || message.includes(PLUGIN_MANIFEST_SCHEMA_MISMATCH_ERROR)
    || message.includes(PLUGIN_MANIFEST_UNSUPPORTED_CAPABILITY_ERROR)
  ) {
    return 'quarantined';
  }

  return 'degraded';
}

export function freezePluginRuntimeState(
  registrySnapshot: PluginRegistryStateSnapshot,
  runtimeSnapshot: PluginRuntimeStateSnapshot = createPluginRuntimeStateSnapshot({ pluginName: registrySnapshot.pluginName }),
  runtimeObservation: {
    currentGeneration?: number | null;
    servingGeneration?: number | null;
    drainingGenerations?: number[];
    servingScopes?: PluginScope[];
    failedGeneration?: number | null;
  } = {},
): FrozenPluginRuntimeState {
  const runtimeLoaded = deriveRuntimeLoadedState(registrySnapshot.validation, runtimeSnapshot.loadState);
  const currentGeneration = runtimeObservation.currentGeneration ?? null;
  const servingGeneration = runtimeObservation.servingGeneration ?? (runtimeLoaded === 'loaded' ? currentGeneration : null);
  const drainingGenerations = runtimeObservation.drainingGenerations ?? [];
  const observableServingScopes = runtimeObservation.servingScopes
    ?? (runtimeLoaded === 'loaded' ? runtimeSnapshot.servingScopes : []);
  const canServe = registrySnapshot.validation === 'validated'
    && registrySnapshot.persistedEnabled === 'enabled'
    && runtimeLoaded === 'loaded'
    && runtimeSnapshot.servingScopes.length > 0;
  const scopedServing: PluginScopedServingState = canServe ? 'serving' : 'non-serving';

  return {
    pluginName: registrySnapshot.pluginName,
    lifecycle: deriveLifecycleState(registrySnapshot, runtimeLoaded, scopedServing),
    authorities: {
      discovery: 'plugin-registry',
      validation: 'plugin-registry',
      persistedEnabled: 'plugin-registry',
      runtimeLoaded: 'scoped-plugin-registry',
      scopedServing: 'scoped-plugin-registry',
    },
    states: {
      discovery: registrySnapshot.discovery,
      validation: registrySnapshot.validation,
      persistedEnabled: registrySnapshot.persistedEnabled,
      runtimeLoaded,
      scopedServing,
    },
    runtime: {
      servingScopes: observableServingScopes.map((scope) => ({ ...scope })),
      currentGeneration,
      servingGeneration,
      drainingGenerations: [...drainingGenerations],
    },
    contract: registrySnapshot.contract
      ? {
        ...registrySnapshot.contract,
        capabilities: [...registrySnapshot.contract.capabilities],
        contractWarnings: [...registrySnapshot.contract.contractWarnings],
        engines: registrySnapshot.contract.engines ? { ...registrySnapshot.contract.engines } : undefined,
      }
      : null,
    reasons: {
      validation: registrySnapshot.failureReason,
      runtime: runtimeSnapshot.failureReason,
    },
    failures: {
      validation: buildValidationFailureSnapshot(registrySnapshot),
      runtime: buildRuntimeFailureSnapshot(runtimeSnapshot, runtimeObservation.failedGeneration ?? currentGeneration),
    },
  };
}

function buildValidationFailureSnapshot(
  registrySnapshot: PluginRegistryStateSnapshot,
): PluginFailureSnapshot | undefined {
  if (
    !registrySnapshot.failureReason
    || (registrySnapshot.validation !== 'degraded' && registrySnapshot.validation !== 'quarantined')
  ) {
    return undefined;
  }

  return {
    stage: 'validation',
    classification: registrySnapshot.validation,
    reason: registrySnapshot.failureReason,
    code: registrySnapshot.contract?.validationFailureCode,
  };
}

function buildRuntimeFailureSnapshot(
  runtimeSnapshot: PluginRuntimeStateSnapshot,
  generation: number | null,
): PluginFailureSnapshot | undefined {
  if (
    !runtimeSnapshot.failureReason
    || (runtimeSnapshot.loadState !== 'degraded' && runtimeSnapshot.loadState !== 'quarantined')
  ) {
    return undefined;
  }

  return {
    stage: 'runtime',
    classification: runtimeSnapshot.loadState,
    reason: runtimeSnapshot.failureReason,
    code: runtimeSnapshot.failureCode,
    generation: generation ?? undefined,
  };
}

function deriveRuntimeLoadedState(
  validation: PluginValidationState,
  runtimeLoadState: PluginRuntimeLoadState,
): PluginRuntimeLoadState {
  if (validation === 'quarantined') {
    return 'quarantined';
  }
  if (validation === 'degraded') {
    return 'degraded';
  }
  return runtimeLoadState;
}

function deriveLifecycleState(
  registrySnapshot: PluginRegistryStateSnapshot,
  runtimeLoaded: PluginRuntimeLoadState,
  scopedServing: PluginScopedServingState,
): PluginLifecycleState {
  if (registrySnapshot.discovery === 'undiscovered') {
    return 'undiscovered';
  }
  if (registrySnapshot.validation === 'quarantined' || runtimeLoaded === 'quarantined') {
    return 'quarantined';
  }
  if (registrySnapshot.validation === 'degraded' || runtimeLoaded === 'degraded') {
    return 'degraded';
  }
  if (scopedServing === 'serving') {
    return 'serving';
  }
  if (registrySnapshot.persistedEnabled === 'disabled') {
    return 'disabled';
  }
  if (runtimeLoaded === 'loaded') {
    return 'loaded';
  }
  if (registrySnapshot.persistedEnabled === 'enabled') {
    return 'enabled';
  }
  if (registrySnapshot.validation === 'validated') {
    return 'validated';
  }
  return 'discovered';
}
