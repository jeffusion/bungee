#!/usr/bin/env node
import { Command } from 'commander';
import { recoverCommand } from './commands/recover';
import { initCommand } from './commands/init';
import { startCommand } from './commands/start';
import { stopCommand } from './commands/stop';
import { statusCommand } from './commands/status';
import { restartCommand } from './commands/restart';
import { logsCommand } from './commands/logs';
import { uiCommand } from './commands/ui';
import { upgradeCommand } from './commands/upgrade';
import { exportCommand, importCommand } from './commands/config-io';
import { DEFAULT_MANAGEMENT_PORT } from './commands/management';
import pkg from '../package.json';
import { oauthCallbackCommand } from '../../core/src/oauth-callback';

export function createProgram() {
  const program = new Command()
    .name('bungee')
    .description('High-performance reverse proxy server built with Bun and TypeScript')
    .version(pkg.version);

  program
    .command('oauth-callback')
    .description('Capture one SIWC browser callback on 127.0.0.1:1455 for manual submission to Bungee')
    .action(async () => {
      try { await oauthCallbackCommand(); }
      catch { console.error('OAuth callback capture failed or was cancelled. Check the local port and restart the login.'); process.exitCode = 1; }
    });

  program
    .command('init')
    .description('Initialize the Bungee SQLite data directory')
    .action(initCommand);

  program
    .command('recover')
    .description('Recover a stopped instance using bounded JSON from stdin or a 0600 file')
    .option('--file <path>', 'Owner-only 0600 recovery JSON input file')
    .addHelpText('after', `
Stop the instance first. Supply one JSON object via stdin or bungee recover --file recovery.json (chmod 600).
Administrator identity: {"kind":"identity","plugin":"local-accounts","payload":{"username":"admin","password":"<new password, 15-128 characters>","reason":"Lost credentials"}}
Unresolved usage: {"kind":"plugin-state","plugin":"token-budget","payload":{"keyId":"KEY_ID","requestId":"REQUEST_ID","attemptId":"ATTEMPT_ID","inputTokens":100,"outputTokens":200,"reason":"Verified usage evidence"}}
Usage counts are replacement totals for the specified attempt, applied to its original period.
`)
    .action(recoverCommand);

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
    .description('Open web dashboard from the Management server')
    .option('-p, --port <port>', 'Management server port', DEFAULT_MANAGEMENT_PORT)
    .option('-H, --host <host>', 'Management server host', 'localhost')
    .action(uiCommand);

  program
    .command('export')
    .description('Export current configuration from the Management server as a versioned snapshot JSON')
    .requiredOption('-o, --file <path>', 'Output file path')
    .option('-p, --port <port>', 'Management server port', DEFAULT_MANAGEMENT_PORT)
    .option('-H, --host <host>', 'Management server host', 'localhost')
    .option('-t, --token <token>', 'Management auth token')
    .action(exportCommand);

  program
    .command('import')
    .description('Restore configuration on the Management server from a versioned snapshot JSON')
    .requiredOption('-f, --file <path>', 'Snapshot file path')
    .option('-p, --port <port>', 'Management server port', DEFAULT_MANAGEMENT_PORT)
    .option('-H, --host <host>', 'Management server host', 'localhost')
    .option('-t, --token <token>', 'Management auth token')
    .action(importCommand);

  program
    .command('upgrade')
    .description('Upgrade Bungee binary to the latest version')
    .option('-f, --force', 'Force re-download even if already up to date')
    .action(upgradeCommand);

  return program;
}

export const program = createProgram();

if (import.meta.main) program.parse();
