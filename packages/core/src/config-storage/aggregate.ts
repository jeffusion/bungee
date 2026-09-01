import type {
  ConfigurationAggregateV2,
  PluginActivationV2,
} from '@jeffusion/bungee-types';
import { parseNormalizeCompile } from './compiler';
import { preflightJsonGraph } from './json-preflight';
import type { ConfigurationCompileOptions } from './plugin-schema';
import { isPluginName } from './plugin-name';
import {
  type ConfigurationError,
  type ConfigurationResult,
  rejectUnknownFields,
  ValidationContext,
} from './validation';

const AGGREGATE_FIELDS = new Set([
  'logical_configuration',
  'plugin_activations',
]);
const ACTIVATION_FIELDS = new Set(['plugin_name']);

function prefixLogicalError(error: ConfigurationError): ConfigurationError {
  return {
    ...error,
    path: error.path
      ? `logical_configuration.${error.path}`
      : 'logical_configuration',
  };
}

function comparePluginNames(
  left: PluginActivationV2,
  right: PluginActivationV2,
): number {
  if (left.plugin_name < right.plugin_name) return -1;
  if (left.plugin_name > right.plugin_name) return 1;
  return 0;
}

function parsePluginActivations(
  value: unknown,
  present: boolean,
  context: ValidationContext,
  availablePlugins?: ReadonlySet<string>,
): PluginActivationV2[] {
  if (!present) {
    context.add('required', 'plugin_activations', 'Required field is missing');
    return [];
  }

  const candidates = context.array(value, 'plugin_activations', true);
  const activations: PluginActivationV2[] = [];
  const names = new Set<string>();
  candidates.forEach((candidate, index) => {
    const itemPath = `plugin_activations[${index}]`;
    const object = context.object(candidate, itemPath);
    if (!object) return;
    rejectUnknownFields(object, ACTIVATION_FIELDS, itemPath, context);
    const name = context.string(object, 'plugin_name', `${itemPath}.plugin_name`);
    if (typeof object.plugin_name !== 'string') return;
    if (!name) {
      context.add('invalid_value', `${itemPath}.plugin_name`, 'Plugin name must not be empty');
      return;
    }
    if (!isPluginName(name)) {
      context.add(
        'invalid_value',
        `${itemPath}.plugin_name`,
        'Plugin name must use lowercase ASCII letters, digits, and single hyphens',
      );
      return;
    }
    if (availablePlugins !== undefined && !availablePlugins.has(name)) {
      context.add('unknown_plugin', `${itemPath}.plugin_name`, 'Plugin is not present in the compile catalog');
      return;
    }
    if (names.has(name)) {
      context.add('duplicate_name', `${itemPath}.plugin_name`, 'Plugin activation name must be unique');
      return;
    }
    names.add(name);
    activations.push({ plugin_name: name });
  });
  return activations.sort(comparePluginNames);
}

export function parseNormalizeCompileAggregate(
  input: unknown,
  options?: ConfigurationCompileOptions,
): ConfigurationResult<ConfigurationAggregateV2> {
  const context = new ValidationContext();
  const safeInput = preflightJsonGraph(input, context);
  if (context.errors.length) return { ok: false, errors: context.errors };

  const root = context.object(safeInput, '') ?? {};
  rejectUnknownFields(root, AGGREGATE_FIELDS, '', context);
  const hasLogicalConfiguration = 'logical_configuration' in root;
  if (!hasLogicalConfiguration) {
    context.add('required', 'logical_configuration', 'Required field is missing');
  }
  const pluginActivations = parsePluginActivations(
    root.plugin_activations,
    'plugin_activations' in root,
    context,
    options?.availablePlugins ?? (options ? new Set(options.pluginSchemas.keys()) : undefined),
  );
  const logicalResult = hasLogicalConfiguration
    ? parseNormalizeCompile(root.logical_configuration, options)
    : undefined;
  if (logicalResult && !logicalResult.ok) {
    context.errors.push(...logicalResult.errors.map(prefixLogicalError));
  }
  if (context.errors.length || !logicalResult || !logicalResult.ok) {
    return { ok: false, errors: context.errors };
  }
  return {
    ok: true,
    value: {
      logical_configuration: logicalResult.value,
      plugin_activations: pluginActivations,
    },
  };
}
