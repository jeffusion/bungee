import {expect,test} from 'bun:test';
import {resolve} from 'node:path';
import {createDaemonRuntime} from './runtime';
test('daemon start uses same explicit config database path as local initialization',()=>{
 const runtime=createDaemonRuntime({dataDirectory:'/tmp/bungee-user-data',logsDirectory:'/tmp/bungee-user-logs',inheritedEnvironment:{BUNGEE_CONFIG_DB_PATH:'./custom/database.db'}});
 expect(runtime.env.BUNGEE_CONFIG_DB_PATH).toBe(resolve('./custom/database.db'));
 expect(runtime.cwd).toBe('/tmp/bungee-user-data');
 const standard=createDaemonRuntime({dataDirectory:'/tmp/bungee-user-data',logsDirectory:'/tmp/bungee-user-logs'});
 expect(standard.env.BUNGEE_CONFIG_DB_PATH).toBe('/tmp/bungee-user-data/bungee.db');
});
