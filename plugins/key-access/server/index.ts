import { definePlugin } from '@jeffusion/bungee-core/plugin';
export { createIngress } from './policy';
export default definePlugin(class {
  static readonly name = 'key-access';
  static readonly version = '1.0.0';
  bodyRequirements(): import('@jeffusion/bungee-core/plugin').PluginBodyRequirements { return { request: 'none' }; }
  register() {}
  resolveAdmissionModel(input: {url: string; body: unknown}): string | null {
    const url = new URL(input.url);
    const gemini = /\/models\/([^/:]+):(?:streamGenerateContent|generateContent)$/.exec(url.pathname);
    if (gemini) {
      try { return decodeURIComponent(gemini[1]!); } catch { return null; }
    }
    // The gateway supplies the final structured representation after rewrites.
    const body = input.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const model = (body as Record<string, unknown>).model;
    return typeof model === 'string' && model.length > 0 ? model : null;
  }
});
