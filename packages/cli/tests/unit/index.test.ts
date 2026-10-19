import { describe, expect, test } from 'bun:test';
import { createProgram } from '../../src/index';

function command(name: string) {
  const result = createProgram().commands.find((candidate) => candidate.name() === name);
  if (result === undefined) throw new Error(`Command ${name} is not registered`);
  return result;
}

describe('management command registration', () => {
  test('only init accepts an explicit plugin secrets key', async () => {
    const cli = createProgram();
    const init = cli.commands.find(candidate => candidate.name() === 'init')!;
    let parsed: string | undefined;
    init.action(options => { parsed = options.pluginSecretsKey; });
    await cli.parseAsync(['node', 'bungee', 'init', '--plugin-secrets-key', 'test-key']);
    expect(parsed).toBe('test-key');
    for (const name of ['start', 'restart', 'recover']) {
      expect(command(name).options.some(option => option.long === '--plugin-secrets-key')).toBe(false);
    }
  });
  for (const name of ['ui', 'export', 'import']) {
    test(`${name} parses the Management server default port`, async () => {
      const cli = createProgram();
      const registered = cli.commands.find((candidate) => candidate.name() === name);
      if (registered === undefined) throw new Error(`Command ${name} is not registered`);
      let parsed: Record<string, string | undefined> | undefined;
      registered.action((options: Record<string, string | undefined>) => {
        parsed = options;
      });

      const args = name === 'export'
        ? ['node', 'bungee', name, '--file', '/tmp/config.json']
        : name === 'import'
          ? ['node', 'bungee', name, '--file', '/tmp/config.json']
          : ['node', 'bungee', name];
      await cli.parseAsync(args);
      expect(parsed?.port).toBe('8089');
    });
  }

  test('registers Management server help and port defaults', () => {
    for (const name of ['ui', 'export', 'import']) {
      const registered = command(name);
      const port = registered.options.find((option) => option.long === '--port');
      expect(port?.defaultValue).toBe('8089');
      expect(registered.helpInformation()).toContain('Management server port');
      expect(registered.helpInformation()).toContain('Management server host');
    }
  });
  test('help exposes optional administrator recovery and removes management-key rotation', () => {
    expect(command('recover').helpInformation()).not.toContain('management-key');
    expect(command('import').options.some(option => option.long === '--next-token')).toBe(false);
  });

});

describe('offline recovery command registration',()=>{
 test('exposes only explicit plugin actions and structured file input',async()=>{
  const cli=createProgram(),registered=cli.commands.find(candidate=>candidate.name()==='recover')!;
  let parsed:Record<string,string>={};registered.action(options=>{parsed=options;});
  await cli.parseAsync(['node','bungee','recover','--plugin','user-auth','--action','reset']);
  expect(parsed).toMatchObject({plugin:'user-auth',action:'reset'});
  expect(registered.helpInformation()).toContain('issue-setup-code');
  expect(registered.helpInformation()).toContain('release-auth');
  expect(registered.helpInformation()).not.toContain('local-accounts');
 });
});

test('offline action validation rejects ambiguous input before resolving a launch',async()=>{
 const {recoverCommand}=await import('../../src/commands/recover');
 for(const options of [{plugin:'user-auth'}, {action:'reset'}, {plugin:'user-auth',action:'unknown'}, {plugin:'user-auth',action:'reset',file:'input.json'}, {plugin:'../user-auth',action:'reset'}]){
  await expect(recoverCommand(options)).rejects.toThrow('invalid_recovery_arguments');
 }
});
