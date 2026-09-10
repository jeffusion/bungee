export type NativeWidgetHeader = {
  summary: string;
  refresh: { label: string; busy: boolean; disabled: boolean; run: () => void };
};

export type NativeWidgetHeaderChange = (header: NativeWidgetHeader | null) => void;
