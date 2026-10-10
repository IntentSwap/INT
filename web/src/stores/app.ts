// Site-wide state: public settings, service health, and the server's clock.

import { create } from "zustand";
import type { ConfigResponse, StatusResponse } from "../../../shared/api.ts";
import { api, ApiError } from "../api.ts";
import { ghostHolds, KEPT, readKept, writeKept } from "../lib/kept.ts";
import { useOrders } from "./orders.ts";

export type Boot = "loading" | "ready" | "region" | "offline";

interface AppState {
  boot: Boot;
  config: ConfigResponse | null;
  health: StatusResponse["status"] | null;
  /** Server time minus this device's time, in ms. Every deadline uses the server's clock. */
  clockOffset: number;
  load(): Promise<void>;
  checkHealth(): Promise<void>;
}

export const useApp = create<AppState>((set, get) => ({
  boot: "loading",
  config: null,
  health: null,
  clockOffset: 0,
  async load() {
    try {
      const config = await api.config();
      set({ boot: "ready", config, health: config.paused ? "paused" : (get().health ?? "ok"), clockOffset: Date.parse(config.serverNow) - Date.now() });
      void get().checkHealth();
      // A practice server has sample orders, so that the list of recent orders can be seen full. The live site names none.
      // They are put on the list once in a browser. After that the list is the person's own: clearing it leaves it cleared.
      // The browser notes that it has them. Without storage they are fetched again on the next visit, which harms nothing.
      // In Ghost mode there is no list to put them on, and they are not asked for.
      if (config.practice && config.sampleOrders.length > 0 && !ghostHolds() && readKept(KEPT.listed) !== "1") {
        const held = new Set(useOrders.getState().orders.map((order) => order.id));
        void Promise.all(config.sampleOrders.filter((id) => !held.has(id)).map((id) => api.order(id).catch(() => null))).then((orders) => {
          useOrders.getState().addOlder(orders.filter((order) => order !== null));
          writeKept(KEPT.listed, "1");
        });
      }
    } catch (err) {
      set({ boot: err instanceof ApiError && err.code === "region" ? "region" : "offline" });
    }
  },
  async checkHealth() {
    try {
      const status = await api.status();
      set({ health: status.status, clockOffset: Date.parse(status.serverNow) - Date.now() });
    } catch (err) {
      if (err instanceof ApiError && err.code === "region") set({ boot: "region" });
    }
  },
}));

/** The current time by the server's clock. */
export function serverNow(): number {
  return Date.now() + useApp.getState().clockOffset;
}
