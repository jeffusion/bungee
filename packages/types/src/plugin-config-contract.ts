/** Runtime instance placement declared by a plugin manifest. */
export type PluginRuntimeScope = 'global' | 'scoped' | 'global-and-scoped';

/** Whitelist of scalar tuples across independent, top-level config fields.
 * Omitted fields do not match a tuple; an entirely omitted optional group is ignored.
 * Required-field checks remain the responsibility of configSchema.
 */
export interface PluginAllowedTuplesConstraint {
  readonly type: 'allowed-tuples';
  readonly fields: readonly string[];
  readonly tuples: readonly (readonly (string | number | boolean | null)[])[];
  readonly message?: string;
}
export type PluginConfigConstraint = PluginAllowedTuplesConstraint;

export function pluginConfigConstraintSatisfied(
  options: Readonly<Record<string, unknown>>,
  constraint: PluginConfigConstraint,
): boolean {
  const values = constraint.fields.map(field => options[field]);
  if (values.every(value => value === undefined)) return true;
  return constraint.tuples.some(tuple => tuple.length === values.length
    && tuple.every((value, index) => value === values[index]));
}
