/** Name-only heuristics: prices always come from the current catalog. */
function resourceName(name: string): string {
  return name.replace(/^(?:projects\/[^/]+\/locations\/[^/]+\/)?publishers\/google\/models\//, '')
    .replace(/^models\//, '');
}

function claudeVersion(name: string): string {
  return name.replace(/^(claude-(?:(?:opus|sonnet|haiku)-)?\d+)-(\d+)(?=-|$)/, '$1.$2');
}

function withoutDate(name: string): string {
  return name.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '');
}

function withoutEffort(name: string): string {
  return name.replace(/-(?:minimal|low|medium|high|xhigh)$/, '');
}

function withoutPreview(name: string): string {
  return name.replace(/-(?:latest|preview|exp)$/, '');
}

/** At most 32 candidates, including combined date/effort suffixes. */
export function estimateNames(model: string): readonly string[] {
  const names = new Set([model.trim().toLowerCase()]);
  const transforms = [resourceName, claudeVersion, withoutDate, withoutEffort, withoutPreview];
  for (const name of names) {
    for (const transform of transforms) {
      const candidate = transform(name);
      if (candidate && names.size < 32) names.add(candidate);
    }
  }
  return [...names];
}

export function canonicalModelName(model: string): string {
  return claudeVersion(resourceName(model.trim().toLowerCase()));
}

export function modelFamily(model: string): string {
  let name = canonicalModelName(model);
  // Each pass removes a suffix; the length bound also bounds this loop.
  for (;;) {
    const next = withoutPreview(withoutEffort(withoutDate(name)));
    if (next === name) return name;
    name = next;
  }
}

export function modelDate(model: string): string {
  return model.toLowerCase().match(/-(\d{8}|\d{4}-\d{2}-\d{2})(?:-(?:minimal|low|medium|high|xhigh|latest|preview|exp))*$/)?.[1]?.replaceAll('-', '') ?? '';
}

export function originalLab(model: string): string | null {
  const name = resourceName(model.trim().toLowerCase());
  if (/^(?:gpt-|o\d+(?:-|$))/.test(name)) return 'openai';
  if (name.startsWith('claude-')) return 'anthropic';
  if (name.startsWith('gemini-')) return 'google';
  if (name.startsWith('grok-')) return 'xai';
  return null;
}
