// Only one sheet is ever open. Opening another replaces the first.
// (The coin picker is not a sheet: it is a view of the swap card. See stores/picker.ts.)

import { create } from "zustand";

export type SheetName = "review" | "menu" | "slippage";

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
