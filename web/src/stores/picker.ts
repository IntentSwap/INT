// Which side's coin picker is open inside the swap card, if either.
//
// The picker is a view of the card, not a sheet laid over the page, so it is kept apart from the
// sheets (the menu can still open over it). Opening it adds a page to the browser's history under
// the same address: the Back button then returns to the swap, and the next Back leaves the site as
// it would have before. Forward opens the picker again.

import { create } from "zustand";
import { pickerInHistory } from "../lib/swap-logic.ts";

export type PickerSide = "from" | "to";

interface PickerState {
  side: PickerSide | null;
}

export const usePicker = create<PickerState>(() => ({ side: null }));

/** True from the moment the picker's page of history is being left until the browser says it has been. */
let leaving = false;

/** Opens the picker for one side of the swap. */
export function openPicker(side: PickerSide): void {
  if (leaving) {
    // The browser is still on its way back from the last picker: this one opens once it has arrived.
    window.addEventListener("popstate", () => openPicker(side), { once: true });
    return;
  }
  // The same address, with a note of which picker this page of history is.
  window.history.pushState({ picker: side }, "");
  usePicker.setState({ side });
}

/** Closes the picker: at once on the page, and in the browser's history by going back over the page it added. */
export function closePicker(): void {
  usePicker.setState({ side: null });
  if (pickerInHistory(window.history.state) === null || leaving) return;
  leaving = true;
  window.history.back();
}

/**
 * Keeps the picker in step with the browser's history for as long as the swap card is on the page.
 * Arriving on a page of history that is a picker (Forward, or a reload) opens it; leaving one closes it.
 */
export function watchPickerHistory(): () => void {
  const sync = () => {
    leaving = false;
    usePicker.setState({ side: pickerInHistory(window.history.state) });
  };
  sync();
  window.addEventListener("popstate", sync);
  return () => {
    window.removeEventListener("popstate", sync);
    leaving = false;
    usePicker.setState({ side: null });
  };
}
