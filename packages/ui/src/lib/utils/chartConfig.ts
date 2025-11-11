import type { ChartOptions } from 'chart.js';

/**
 * 创建图表标题配置
 */
export function createTitleConfig(title: string, textColor: string, display: boolean = true) {
  return {
    display: display && !!title,
    text: title,
    color: textColor,
    font: {
      size: 16,
      weight: 'bold' as const
    }
  };
}

/**
 * 创建图例配置
 */
export interface LegendOptions {
  position?: 'top' | 'bottom' | 'left' | 'right';
  display?: boolean;
  padding?: number;
  fontSize?: number;
}

export function createLegendConfig(
  textColor: string,
  options: LegendOptions = {}
) {
  const {
    position = 'top',
    display = true,
    padding = 15,
    fontSize = 11
  } = options;

  return {
    display,
    position: position as const,
    labels: {
      padding,
      font: { size: fontSize },
      color: textColor
    }
  };
}

/**
 * 创建坐标轴配置
 */
export interface ScaleOptions {
  stacked?: boolean;
  beginAtZero?: boolean;
  fontSize?: number;
  maxRotation?: number;
  minRotation?: number;
  title?: {
    display: boolean;
    text: string;
  };
}

export function createScaleConfig(
  textColor: string,
  gridColor: string,
  options: ScaleOptions = {}
) {
  const {
    stacked = false,
    beginAtZero = true,
    fontSize = 11,
    maxRotation,
    minRotation,
    title
  } = options;

  const config: any = {
    stacked,
    beginAtZero,
    ticks: {
      font: { size: fontSize },
      color: textColor
    },
    grid: {
      color: gridColor
    }
  };

  if (title) {
    config.title = {
      display: title.display,
      text: title.text,
      color: textColor
    };
  }

  if (maxRotation !== undefined) {
    config.ticks.maxRotation = maxRotation;
  }

  if (minRotation !== undefined) {
    config.ticks.minRotation = minRotation;
  }

  return config;
}

/**
 * 创建工具提示配置
 */
export function createTooltipConfig(mode: 'index' | 'nearest' = 'index', intersect: boolean = false) {
  return {
    mode: mode as const,
    intersect
  };
}
