export function normalizeManagementPath(pathname: string): string {
  return pathname === '/__ui/api' || pathname.startsWith('/__ui/api/')
    ? `/api${pathname.slice('/__ui/api'.length)}`
    : pathname;
}
