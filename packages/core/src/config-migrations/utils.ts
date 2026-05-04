function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export function getAtPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  return path.split('.').reduce<unknown>((current, segment) => {
    if (!isPlainObject(current) && !Array.isArray(current)) {
      return undefined;
    }
    return (current as any)[segment];
  }, obj);
}

export function setAtPath(obj: Record<string, any>, path: string, value: unknown): void {
  const segments = path.split('.');
  let current: Record<string, any> = obj;

  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (!isPlainObject(current[segment])) {
      current[segment] = {};
    }
    current = current[segment];
  }

  current[segments[segments.length - 1]] = value;
}

export function deleteAtPath(obj: Record<string, any>, path: string): void {
  const segments = path.split('.');
  let current: Record<string, any> = obj;

  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (!isPlainObject(current[segment])) {
      return;
    }
    current = current[segment];
  }

  delete current[segments[segments.length - 1]];
}

export function cleanupEmptyObjects(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cleanupEmptyObjects);
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const cleanedEntries = Object.entries(value)
    .map(([key, child]) => [key, cleanupEmptyObjects(child)] as const)
    .filter(([, child]) => {
      if (child === undefined) return false;
      if (isPlainObject(child) && Object.keys(child).length === 0) return false;
      return true;
    });

  return Object.fromEntries(cleanedEntries);
}

export function detectConfigVersion(rawConfig: unknown): number {
  if (!isPlainObject(rawConfig)) {
    return 1;
  }

  const version = rawConfig.configVersion;
  return typeof version === 'number' && Number.isInteger(version) && version > 0 ? version : 1;
}

export function isPlainRecord(value: unknown): value is Record<string, any> {
  return isPlainObject(value);
}
