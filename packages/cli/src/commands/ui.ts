import { DEFAULT_MANAGEMENT_PORT } from './management';

export async function uiCommand(options: { port?: string; host?: string }) {
  const port = parseInt(options.port ?? DEFAULT_MANAGEMENT_PORT);
  const host = options.host || 'localhost';
  const url = `http://${host}:${port}/`;

  console.log(`\n🚀 Opening Bungee Dashboard at ${url}\n`);

  // 根据平台打开浏览器
  const command = process.platform === 'darwin' ? 'open' :
                  process.platform === 'win32' ? 'start' : 'xdg-open';

  try {
    await Bun.spawn([command, url]);
  } catch (error) {
    console.error(`Failed to open browser automatically.`);
    console.log(`Please open ${url} manually in your browser.\n`);
  }
}
