type ToastKind = 'success' | 'error' | 'info';

export interface ToastInput {
  text: string;
  kind?: ToastKind;
  duration?: number;
}

export function showToast(_input: ToastInput): void {
  // Global toast notifications are intentionally disabled.
}
