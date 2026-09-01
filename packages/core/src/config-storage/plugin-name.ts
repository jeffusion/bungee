export const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function isPluginName(value: string): boolean {
  return PLUGIN_NAME_PATTERN.test(value);
}
