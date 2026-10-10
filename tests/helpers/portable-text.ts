export function portablePath(path: string): string {
  return path.replaceAll('\\', '/');
}

export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}
