#!/usr/bin/env node
import { program } from 'commander';
import { initCommand } from './commands/init';
import { startCommand } from './commands/start';
import { stopCommand } from './commands/stop';
import { statusCommand } from './commands/status';
import { restartCommand } from './commands/restart';
import { logsCommand } from './commands/logs';
import { uiCommand } from './commands/ui';
import { upgradeCommand } from './commands/upgrade';
import { exportCommand, importCommand } from './commands/config-io';
import pkg from '../package.json';

program
  .name('bungee')
  .description('High-performance reverse proxy server built with Bun and TypeScript')
  .version(pkg.version);

program
  .command('init')
  .description('Initialize the Bungee SQLite data directory')
  .action(initCommand);

program
  .command('start')
  .description('Start proxy server as daemon')
  .option('-p, --port <port>', 'Override default port')
  .option('-w, --workers <count>', 'Number of worker processes', '2')
  .option('-d, --detach', 'Run as daemon (default)', true)
  .option('--auto-upgrade', 'Automatically upgrade binary if version mismatch')
  .action(startCommand);

program
  .command('stop')
  .description('Stop proxy server daemon')
  .action(stopCommand);

program
  .command('restart')
  .description('Restart proxy server daemon')
  .option('-p, --port <port>', 'Override default port')
  .option('-w, --workers <count>', 'Number of worker processes', '2')
  .option('--auto-upgrade', 'Automatically upgrade binary if version mismatch')
  .action(restartCommand);

program
  .command('status')
  .description('Show daemon status and health')
  .action(statusCommand);

program
  .command('logs')
  .description('Show daemon logs')
  .option('-f, --follow', 'Follow log output')
  .option('-n, --lines <number>', 'Number of lines to show', '50')
  .action(logsCommand);

program
  .command('ui')
  .description('Open web dashboard (proxy server must be running)')
  .option('-p, --port <port>', 'Proxy server port', '8088')
  .option('-H, --host <host>', 'Proxy server host', 'localhost')
  .action(uiCommand);

program
  .command('export')
  .description('Export current configuration as a versioned snapshot JSON')
  .requiredOption('-o, --file <path>', 'Output file path')
  .option('-p, --port <port>', 'Proxy server port', '8088')
  .option('-H, --host <host>', 'Proxy server host', 'localhost')
  .option('-t, --token <token>', 'Management auth token')
  .action(exportCommand);

program
  .command('import')
  .description('Restore configuration from a versioned snapshot JSON')
  .requiredOption('-f, --file <path>', 'Snapshot file path')
  .option('-p, --port <port>', 'Proxy server port', '8088')
  .option('-H, --host <host>', 'Proxy server host', 'localhost')
  .option('-t, --token <token>', 'Management auth token')
  .option('--next-token <token>', 'Next management token when the imported config rotates auth')
  .action(importCommand);

program
  .command('upgrade')
  .description('Upgrade Bungee binary to the latest version')
  .option('-f, --force', 'Force re-download even if already up to date')
  .action(upgradeCommand);

program.parse();
