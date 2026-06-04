import { writable, derived } from 'svelte/store';
import type { AppConfig } from '$types';

// 配置状态
export const configStore = writable<AppConfig | null>(null);

// 是否正在加载
export const configLoading = writable<boolean>(false);

// 配置错误
export const configError = writable<string | null>(null);

// 派生：路由列表
export const routesStore = derived(
  configStore,
  ($config) => $config?.routes || []
);

// 派生：是否有配置
export const hasConfig = derived(
  configStore,
  ($config) => $config !== null
);

// 配置操作辅助函数
export const configActions = {
  // 设置配置
  setConfig(config: AppConfig) {
    configStore.set(config);
    configError.set(null);
  },

  // 设置加载状态
  setLoading(loading: boolean) {
    configLoading.set(loading);
  },

  // 设置错误
  setError(error: string | null) {
    configError.set(error);
  },

  // 清空配置
  clear() {
    configStore.set(null);
    configError.set(null);
    configLoading.set(false);
  }
};
