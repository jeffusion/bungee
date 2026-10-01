import type { Snippet } from 'svelte';

export type NativeWidgetHeader = {
  summary: string;
  refresh: { label: string; busy: boolean; disabled: boolean; run: () => void };
  /** Optional content for the dashboard KPI chassis's existing footer slot. */
  footer?: Snippet;
};

export type NativeWidgetHeaderChange = (header: NativeWidgetHeader | null) => void;
