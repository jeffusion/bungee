import { writable, derived, type Readable } from 'svelte/store';

const browser = typeof window !== 'undefined';

interface ChartThemeColors {
  textColor: string;
  gridColor: string;
}

function createChartThemeStore() {
  const { subscribe, set } = writable<ChartThemeColors>({
    textColor: 'rgba(255, 255, 255, 0.9)',
    gridColor: 'rgba(255, 255, 255, 0.1)'
  });

  let observer: MutationObserver | null = null;
  let mediaQuery: MediaQueryList | null = null;
  let initialized = false;

  function updateColors() {
    if (!browser) return;

    const tempElement = document.createElement('div');
    tempElement.className = 'text-base-content';
    tempElement.style.position = 'absolute';
    tempElement.style.visibility = 'hidden';
    document.body.appendChild(tempElement);

    const computedColor = getComputedStyle(tempElement).color;
    document.body.removeChild(tempElement);

    const match = computedColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)/);
    const gridColor = match
      ? `rgba(${match[1]}, ${match[2]}, ${match[3]}, 0.1)`
      : 'rgba(255, 255, 255, 0.1)';

    set({
      textColor: computedColor,
      gridColor
    });
  }

  function init() {
    if (!browser || initialized) return;

    initialized = true;
    updateColors();

    // 监听主题变化
    observer = new MutationObserver(() => {
      updateColors();
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class']
    });

    // 监听系统颜色方案变化
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => updateColors();
    mediaQuery.addEventListener('change', handleChange);

    // 清理函数（在浏览器关闭时）
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        cleanup();
      });
    }
  }

  function cleanup() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (mediaQuery) {
      mediaQuery.removeEventListener('change', updateColors);
      mediaQuery = null;
    }
    initialized = false;
  }

  return {
    subscribe,
    init,
    cleanup
  };
}

export const chartTheme = createChartThemeStore();

// 便捷的派生 store
export const chartTextColor: Readable<string> = derived(
  chartTheme,
  $theme => $theme.textColor
);

export const chartGridColor: Readable<string> = derived(
  chartTheme,
  $theme => $theme.gridColor
);
