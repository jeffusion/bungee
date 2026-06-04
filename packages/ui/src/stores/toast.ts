import { writable } from 'svelte/store';

export interface ToastMessage {
  id: number;
  message: string;
  type: 'success' | 'error' | 'warning' | 'info';
  duration?: number;
}

function createToastStore() {
  const { subscribe, update } = writable<ToastMessage[]>([]);
  let nextId = 0;

  return {
    subscribe,
    show: (message: string, type: ToastMessage['type'] = 'info', duration = 3000) => {
      const id = nextId++;
      const toast: ToastMessage = { id, message, type, duration };

      update(toasts => [...toasts, toast]);

      if (duration > 0) {
        setTimeout(() => {
          update(toasts => toasts.filter(t => t.id !== id));
        }, duration);
      }

      return id;
    },
    success: (message: string, duration = 3000) => {
      return createToastStore().show(message, 'success', duration);
    },
    error: (message: string, duration = 4000) => {
      return createToastStore().show(message, 'error', duration);
    },
    warning: (message: string, duration = 3500) => {
      return createToastStore().show(message, 'warning', duration);
    },
    info: (message: string, duration = 3000) => {
      return createToastStore().show(message, 'info', duration);
    },
    remove: (id: number) => {
      update(toasts => toasts.filter(t => t.id !== id));
    },
    clear: () => {
      update(() => []);
    }
  };
}

export const toast = createToastStore();
