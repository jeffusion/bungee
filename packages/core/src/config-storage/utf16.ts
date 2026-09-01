export function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function graphHasLoneSurrogate(input: unknown): boolean {
  const pending: unknown[] = [input];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (hasLoneSurrogate(value)) return true;
      continue;
    }
    if (typeof value !== 'object' || value === null || seen.has(value)) continue;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'string' && hasLoneSurrogate(key)) return true;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.enumerable && 'value' in descriptor) pending.push(descriptor.value);
    }
  }
  return false;
}
