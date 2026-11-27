import { DataAdmissionError, definePlugin, type Plugin, type PluginBodyRequirementContext, type PluginBodyRequirements, type PluginHooks, type PluginInitContext } from '@jeffusion/bungee-core/plugin';
import { compileRedactionRules } from '../rules';
import { createStatsRecorder } from './stats';

function redactBody(context: { body: unknown }, rules: NonNullable<ReturnType<typeof compileRedactionRules>>): number {
  // Bound intermediate expansion even when the central final byte check has not run yet.
  let growthBudget = 1024 * 1024;
  let replacements = 0;
  const redact = (text: string) => {
    for (const rule of rules) {
      const matches = rule.matcher.matcher(text);
      if (!matches.find()) continue;
      let result = '';
      let cursor = 0;
      do {
        const start = matches.start();
        const end = matches.end();
        growthBudget -= Math.max(0, rule.replacement.length - (end - start));
        if (growthBudget < 0) throw new DataAdmissionError(422, 'redaction_output_too_large');
        if (rule.replacement.length !== end - start || !text.startsWith(rule.replacement, start)) replacements++;
        result += text.slice(cursor, start) + rule.replacement;
        cursor = end;
      } while (matches.find());
      text = result + text.slice(cursor);
    }
    return text;
  };

  const { body } = context;
  if (typeof body === 'string') {
    context.body = redact(body);
    return replacements;
  }
  if (body === null || typeof body !== 'object') return 0;
  const pending = [body as Record<string, unknown>];
  while (pending.length > 0) {
    const object = pending.pop()!;
    for (const key of Object.keys(object)) {
      const value = object[key];
      if (typeof value === 'string') object[key] = redact(value);
      else if (value !== null && typeof value === 'object') pending.push(value as Record<string, unknown>);
    }
  }
  return replacements;
}

function supportsBody(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

export default definePlugin(class implements Plugin {
  static readonly name = 'request-body-redaction';
  static readonly version = '1.0.0';

  private readonly rules: ReturnType<typeof compileRedactionRules>;
  private stats?: ReturnType<typeof createStatsRecorder>;

  constructor(options?: { rules?: unknown }) {
    this.rules = compileRedactionRules(options?.rules);
  }

  async init(context: PluginInitContext): Promise<void> {
    this.stats = createStatsRecorder(context);
  }

  async onDestroy(): Promise<void> {
    await this.stats?.close();
  }

  bodyRequirements({ method }: PluginBodyRequirementContext): PluginBodyRequirements {
    return { request: this.rules && supportsBody(method) ? 'json-write' : 'none' };
  }

  register(hooks: PluginHooks): void {
    hooks.onBeforeRequest.tap({ name: 'request-body-redaction', stage: 100 }, context => {
      if (!supportsBody(context.method)) return context;
      // A failed scoped initializer can be omitted by the host; keep the hook to reject instead.
      if (!this.rules) throw new DataAdmissionError(503, 'invalid_redaction_rules');
      const replacements = redactBody(context, this.rules);
      this.stats?.record(replacements);
      return context;
    });
  }
});
