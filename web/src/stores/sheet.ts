// Only one sheet is ever open. Opening another replaces the first.

import { create } from "zustand";

export type SheetName = "coin-from" | "coin-to" | "review" | "menu" | "slippage";

interface SheetState {
  current: SheetName | null;
  open(name: SheetName): void;
  close(): void;
}

export const useSheet = create<SheetState>((set) => ({
  current: null,
  open: (name) => set({ current: name }),
  close: () => set({ current: null }),
}));
