// Builds the whole server from configuration: every part, wired the way production runs it.
// Kept apart from the entry point so the wiring itself can be tested.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createAlerts, type Alerts } from "./alerts.ts";
import { createApp } from "./app.ts";
import { ConfigError, describeConfig, loadConfig, type Config } from "./config.ts";
import { createGeo, createStaticGeo, type Geo, type GeoService } from "./geo.ts";
import { createAccessLog, errorKind, hashId, type Logger } from "./log.ts";
import { createDiskGuard, createSweeper, DISK_CHECK_MS, measureDisk, providerErrorAlert, runMaintenance } from "./maintenance.ts";
import { idleBudget, type OneClick } from "./oneclick.ts";
import { createPoller } from "./poller.ts";
import { buildProvider } from "./provider.ts";
import { configuredLimits, createLimiters, type Limiters } from "./ratelimit.ts";
import { createRewards, createSignIn } from "./rewards.ts";
import { createRpc } from "./rpc.ts";
import { holdsSampleContent, seedSamples, withSampleSettings } from "./sample.ts";
import { createSanctions, type SanctionsService } from "./sanctions.ts";
import { createSessionIssuer } from "./session.ts";
import { loadStaticSite } from "./static.ts";
import { createStats } from "./stats.ts";
import { createOrderStore } from "./store.ts";
import { createTokenService } from "./tokens.ts";

/** How often old order records are looked at for deletion. */
const SWEEP_MS = 10 * 60_000;

type Statfs = (dir: string) => { blocks: number | bigint; bavail: number | bigint };

export interface Booted {
  config: Config;
  server: http.Server;
  /** The address to listen on. Only this machine when the practice provider is on; every interface otherwise. */
  listenHost: string | undefined;
  /** True when a real order may be created by this process. */
  liveOrders: boolean;
  practice: boolean;
  geo: Geo;
  sanctions: SanctionsService;
  limiters: Limiters;
  oneclick: OneClick;
  alerts: Alerts;
  diskFull(): boolean;
  /** One round of upkeep: prune logs, measure the disk. */
  maintain(): void;
  /** Deletes order records past their retention time, asking the provider one last time where needed. */
  sweep(): Promise<number>;
  /** Starts background work (list refreshes, polling, upkeep) and listens. */
  start(onListening?: () => void): void;
  stop(done?: () => void): void;
}

/**
 * The practice server's clock: the machine's time plus however far it has been moved forward. It
 * only ever goes forward, and anything that is not a finite, positive number of milliseconds is
 * ignored. Never used in production (see where it is wired in below).
 */
export function practiceClock(real: () => number): { now(): number; skipAhead(ms: number): boolean } {
  let skippedMs = 0;
  return {
    now: () => real() + skippedMs,
    skipAhead(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return false;
      skippedMs += ms;
      return true;
    },
  };
}

export function boot(options: {
  env?: Record<string, string | undefined>;
  log: Logger;
  fetchImpl?: typeof fetch;
  statfs?: Statfs;
  now?: () => number;
  /** Folder holding the built site. */
  siteDir?: string;
}): Booted {
  const { log } = options;
  const net = options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl };
  const config = loadConfig(options.env ?? process.env);
  const production = config.env === "production";
  // The clock. With the practice provider on (local development only) it can be moved forward by a
  // practice control, so that a deadline passing can be seen without waiting an hour. Otherwise it
  // is the machine's clock and nothing can move it.
  const realNow = options.now ?? Date.now;
  const practiceTime = practiceClock(realNow);
  const now = config.providerStub && !production ? practiceTime.now : realNow;

  // The data folder must exist and be writable before anything else runs.
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.accessSync(config.dataDir, fs.constants.W_OK | fs.constants.R_OK);

  log.info("starting", describeConfig(config));

  const alerts = createAlerts({ webhookUrl: config.alertWebhookUrl, log, now, ...net });
  const accessLog = createAccessLog(path.join(config.dataDir, "logs"), now);
  const limiters = createLimiters(now, configuredLimits(config.oneClickMaxPerMin));
  const diskGuard = createDiskGuard();

  // Local development never creates a real order: see server/provider.ts.
  const { oneclick, liveOrders, stub } = buildProvider({ config, log, now, ...net, onErrorRate: (rate, calls) => void providerErrorAlert(alerts, rate, calls) });
  if (stub !== null) log.warn("practice_provider_on");
  // A data folder that a practice server has filled holds made-up orders, points and paid weeks.
  // The live site never starts on one: it would show them as its own record. On a developer's own
  // machine it is only said in the log, so that trying practice mode once does not lock the folder.
  if (stub === null && holdsSampleContent(config.dataDir)) {
    if (config.env === "production") throw new ConfigError("DATA_DIR: this folder holds practice content (it has a file rewards/SAMPLE-CONTENT). The live site does not start on it. Give this server a data folder of its own.");
    log.warn("practice_content_in_data_folder");
  }

  const rpc = createRpc({ urls: config.rpcUrls, ...net });
  const tokens = createTokenService({ oneclick, rpc, alerts, log, dataDir: config.dataDir, excludedChains: config.excludedChains, now });
  // The record of points. Each time an order's state is saved, it is asked whether the order now adds
  // any (a delivered order with a rewards address does, once). At start every stored order is put to
  // it once more, so that a delivery saved a moment before a restart is not missed.
  const rewards = createRewards(config.dataDir);
  // The site's own totals, for the Stats page. They are told of the same orders at the same two
  // moments, and count each once: the order's own record is marked as counted before the totals
  // are touched. They are kept whether or not the page is switched on, so that they are whole when it is.
  const stats = createStats(config.dataDir, { now, receivedMin: config.statsReceivedMin });
  if (stats.setAside) log.error("stats_file_unreadable");
  const store = createOrderStore(config.dataDir, {
    onState(record) {
      try {
        rewards.recordDelivered(record);
      } catch (err) {
        log.error("points_not_recorded", { order: hashId(record.id), error: errorKind(err) });
      }
      try {
        stats.recordDelivered(record, () => store.markCounted(record.id));
      } catch (err) {
        log.error("stats_not_counted", { order: hashId(record.id), error: errorKind(err) });
      }
    },
  });
  for (const id of store.ids()) {
    // One order that cannot be put to the record must not stop the server starting: it is logged, and the rest are still put to it.
    try {
      const record = store.get(id);
      if (record !== null && record.state.status === "delivered") rewards.recordDelivered(record);
    } catch (err) {
      log.error("points_not_recorded", { order: hashId(id), error: errorKind(err) });
    }
    try {
      const record = store.get(id);
      // Added up in memory, and written once after the last of them.
      if (record !== null) stats.recordDelivered(record, () => store.markCounted(id), false);
    } catch (err) {
      log.error("stats_not_counted", { order: hashId(id), error: errorKind(err) });
    }
  }
  try {
    stats.save();
  } catch (err) {
    log.error("stats_not_saved", { error: errorKind(err) });
  }
  const poller = createPoller({ store, oneclick, alerts, log, now, unpaidCallsPerMin: idleBudget(config.oneClickMaxPerMin) });
  const sanctions = createSanctions({ dataDir: config.dataDir, log, alerts, now, ...net });

  // Region blocking needs the location database, and only region blocking does. Where it is off
  // (REGION_BLOCK, off unless set) there is no region service at all: nothing is downloaded, loaded
  // or refreshed, nothing is kept on disk for it, and the server answers as soon as it listens.
  // Local development runs without it either way.
  let geoService: GeoService | null = null;
  let geo: Geo;
  if (production && config.regionBlock) {
    geoService = createGeo({ dataDir: config.dataDir, blockedCountries: config.blockedCountries, production: true, log, alerts, now, ...net });
    geo = geoService;
  } else {
    geo = createStaticGeo();
  }

  // Practice mode only: sample content, and a sample token and reserve where the operator has set none,
  // so that every screen can be looked at full. None of this runs on the live site: `stub` is only
  // ever there in local development (see server/provider.ts and the settings' own refusal).
  const samples = stub === null ? null : seedSamples({ practice: true, dataDir: config.dataDir, store, rewards, stats, now: now() });
  const shown = stub === null ? config : withSampleSettings(config);

  const site = loadStaticSite(options.siteDir ?? path.resolve("web", "dist"), {
    testPages: !production,
    tokenPage: shown.tokenAddress !== null,
    // How this server routes swaps, as the page is told it by /api/config: the site's first words follow it.
    privateRouting: shown.privacyMode === "basic",
    statsPage: config.statsPage,
    // The wallet the Rewards page shows the pool of, where there is one: the page draws its frame from the first paint.
    rewardsWallet: shown.reserveAddress,
    siteUrl: config.siteUrl,
    // What this server will show in its banner for as long as it runs. Known now, so written into the page.
    banner: config.swapsPaused ? (["paused"] as const) : [],
  });
  if (site === null && production) log.warn("site_not_built");

  const app = createApp({
    config: shown,
    log,
    accessLog,
    alerts,
    geo,
    sanctions,
    oneclick,
    tokens,
    store,
    poller,
    rpc,
    limiters,
    sessions: createSessionIssuer(),
    rewards,
    signIn: createSignIn(),
    stats,
    site,
    now,
    liveOrders,
    diskFull: () => diskGuard.full(),
    ...(stub === null
      ? {}
      : {
          extraSigningKeys: [stub.signingKey],
          practice: {
            control: stub.control,
            skipAhead(ms: number) {
              if (!practiceTime.skipAhead(ms)) return;
              // The real provider's answers carry the real time, and would now read as stale.
              stub.localOnly();
            },
            ...(samples === null ? {} : { samples }),
          },
        }),
  });

  const server = http.createServer(app);
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 65_000;
  server.maxHeadersCount = 60;

  const statfs = options.statfs === undefined ? {} : { statfs: options.statfs };
  const maintain = () => {
    // A row of the Stats page is kept for 48 hours, and then it is off the disk within the hour.
    try {
      stats.tidy();
    } catch (err) {
      log.error("stats_not_saved", { error: errorKind(err) });
    }
    diskGuard.record(runMaintenance({ accessLog, limiters, dataDir: config.dataDir, alerts, log, ...statfs }));
  };
  const sweep = createSweeper({ store, poller, log, now });
  const checkDisk = () => diskGuard.record(measureDisk({ dataDir: config.dataDir, alerts, log, ...statfs }));
  const timers: NodeJS.Timeout[] = [];
  // With the practice provider on, only this machine can reach the server.
  const listenHost = stub === null ? undefined : "127.0.0.1";

  return {
    config,
    server,
    listenHost,
    liveOrders,
    practice: stub !== null,
    geo,
    sanctions,
    limiters,
    oneclick,
    alerts,
    diskFull: () => diskGuard.full(),
    maintain,
    sweep,
    start(onListening) {
      if (geoService !== null) {
        void geoService.refresh();
        geoService.start();
      }
      void sanctions.refresh();
      sanctions.start();
      void tokens.refresh();
      poller.start();
      maintain();
      void sweep();
      timers.push(setInterval(maintain, 3_600_000), setInterval(() => void sweep(), SWEEP_MS), setInterval(checkDisk, DISK_CHECK_MS));
      for (const timer of timers) timer.unref();
      server.listen(config.port, listenHost, () => {
        log.info("listening", { port: config.port, openOrders: store.openCount(), paused: config.swapsPaused, localOnly: listenHost !== undefined });
        onListening?.();
      });
    },
    stop(done) {
      poller.stop();
      sanctions.stop();
      geoService?.stop();
      for (const timer of timers) clearInterval(timer);
      server.close(() => done?.());
    },
  };
}
