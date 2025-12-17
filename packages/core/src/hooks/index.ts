/**
 * Hooks 模块导出
 */

// 类型导出
export type {
  TapInfo,
  Tap,
  IAsyncParallelHook,
  IAsyncSeriesHook,
  IAsyncSeriesBailHook,
  IAsyncSeriesWaterfallHook,
  IAsyncSeriesMapHook,
  HookStats,
} from './types';

// Hook 实现类导出
export {
  AsyncParallelHook,
  AsyncSeriesHook,
  AsyncSeriesBailHook,
  AsyncSeriesWaterfallHook,
  AsyncSeriesMapHook,
} from './impl';

// Plugin Hooks 相关导出
export {
  createPluginHooks,
  getHooksStats,
  resetHooksStats,
  clearHooks,
} from './plugin-hooks';

export type {
  PluginHooks,
  RequestContext,
  MutableRequestContext,
  ResponseContext,
  ErrorContext,
  StreamChunkContext,
  FinallyContext,
  PluginInitContext,
  PluginLogger,
  PluginScopeInfo,
} from './plugin-hooks';
