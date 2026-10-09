// Which side's coin picker is open inside the swap card, if either.
//
// The picker is a view of the card, not a sheet laid over the page, so it is kept apart from the
// sheets (the menu can still open over it). Opening it adds a page to the browser's history under
// the same address: the Back button then returns to the swap, and the next Back leaves the site as
// it would have before. Forward opens the picker again.
//
// A card that has just come onto the page starts as the swap, with the picker closed, wherever the
// browser stands. If that is on a picker's page of history (the page was loaded again there, or Back
// led to it from another page), the browser is taken back off it, so no press of Back is spent on a
// page that shows nothing new.

import { create } from "zustand";
import { pickerInHistory } from "../lib/swap-logic.ts";

export type PickerSide = "from" | "to";

interface PickerState {
  side: PickerSide | null;
}

export const usePicker = create<PickerState>(() => ({ side: null }));

/** True from the moment the picker's page of history is being left until the browser says it has been. */
let leaving = false;

/** Goes back over the picker's page of history. The browser arrives a moment later and says so, whether or not the card is still on the page to hear it. */
function stepBack(): void {
  leaving = true;
  window.addEventListener(
    "popstate",
    () => {
      leaving = false;
    },
    { once: true },
  );
  window.history.back();
}

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
  stepBack();
}

/**
 * Keeps the picker in step with the browser's history for as long as the swap card is on the page.
 * The card starts with the picker closed. From then on, the browser's Forward onto a page of
 * history that is a picker opens it, and leaving one closes it.
 */
export function watchPickerHistory(): () => void {
  // On the way back off the picker's page, the picker stays closed whatever page the browser is still on.
  const sync = () => usePicker.setState({ side: leaving ? null : pickerInHistory(window.history.state) });
  closePicker();
  window.addEventListener("popstate", sync);
  return () => {
    window.removeEventListener("popstate", sync);
    usePicker.setState({ side: null });
  };
}
