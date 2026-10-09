// Toasts confirm small actions only ("Copied"). Errors are shown inline, next to their cause.

import { create } from "zustand";

interface ToastState {
  message: string | null;
  show(message: string): void;
}

let timer: ReturnType<typeof setTimeout> | undefined;

export const useToast = create<ToastState>((set) => ({
  message: null,
  show(message) {
    if (timer !== undefined) clearTimeout(timer);
    set({ message });
    timer = setTimeout(() => set({ message: null }), 1500);
  },
}));
