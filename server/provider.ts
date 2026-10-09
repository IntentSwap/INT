// Chooses the swap provider for this process.
//
// Production talks to the real provider. Development may only ask it for
// price previews; with PROVIDER_STUB=true the practice provider answers
// everything else locally. The real client enforces this itself, so no calling
// code can create a real order outside production.

import type { Config } from "./config.ts";
import type { Logger } from "./log.ts";
import { createOneClick, type OneClick } from "./oneclick.ts";
import { createStubProvider, type StubProvider } from "./stub-provider.ts";

export interface ProviderSetup {
  oneclick: OneClick;
  /** Whether order creation is available at all in this process. */
  liveOrders: boolean;
  /** Set only with the practice provider. */
  stub: StubProvider | null;
}

export function buildProvider(options: {
  config: Config;
  log: Logger;
  fetchImpl?: typeof fetch;
  onErrorRate?: (rate: number, calls: number) => void;
  /** The server's clock, which the practice provider follows. */
  now?: () => number;
}): ProviderSetup {
  const { config, log } = options;
  const production = config.env === "production";
  const real = createOneClick({
    apiKey: config.oneClickApiKey,
    maxPerMin: config.oneClickMaxPerMin,
    allowLive: production,
    log,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.onErrorRate ? { onErrorRate: options.onErrorRate } : {}),
  });
  if (production) return { oneclick: real, liveOrders: true, stub: null };
  if (config.providerStub) {
    const stub = createStubProvider({ upstream: real, ...(options.now ? { now: options.now } : {}) });
    return { oneclick: stub.provider, liveOrders: true, stub };
  }
  return { oneclick: real, liveOrders: false, stub: null };
}
