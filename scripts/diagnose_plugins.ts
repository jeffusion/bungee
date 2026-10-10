import { PluginRegistry } from '../packages/core/src/plugin-registry';
import { logger } from '../packages/core/src/logger';

async function diagnose() {
  console.log('=== 插件诊断测试 ===\n');

  const cwd = process.cwd();
  console.log('Current working directory:', cwd);
  console.log('Script location:', import.meta.dir);

  const registry = new PluginRegistry(cwd);

  console.log('\n1. 开始扫描插件目录...');
  await registry.scanAndLoadAllPlugins();

  console.log('\n2. 获取所有插件 schemas...');
  const schemas = registry.getAllPluginSchemas();

  console.log('\n3. 找到的插件:');
  const pluginNames = Object.keys(schemas);
  console.log('插件数量:', pluginNames.length);

  if (pluginNames.length === 0) {
    console.log('❌ 没有找到任何插件！');
  } else {
    pluginNames.forEach(name => {
      const schema = schemas[name];
      console.log(`\n  插件: ${name}`);
      console.log(`    版本: ${schema.version || 'N/A'}`);
      console.log(`    描述: ${schema.description || 'N/A'}`);
      console.log(`    配置字段数: ${schema.configSchema?.length || 0}`);
    });
  }

  // 检查 llm-protocol-adapter 是否存在
  if (schemas['llm-protocol-adapter']) {
    console.log('\n✅ llm-protocol-adapter 插件已找到！');
    console.log(JSON.stringify(schemas['llm-protocol-adapter'], null, 2));
  } else {
    console.log('\n❌ llm-protocol-adapter 插件未找到！');
  }
}

diagnose().catch(err => {
  console.error('错误:', err);
  process.exit(1);
});
