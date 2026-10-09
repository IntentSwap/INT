import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * The styles of the first screen travel inside the page itself. A stylesheet of its own costs a
 * second round trip before anything can be drawn, which on a slow phone connection is most of a
 * second. The page is checked against the server on every visit and re-sent only when it has
 * changed, so a returning visitor fetches these styles no more often than before.
 *
 * The stylesheet file stays in the build, and the page still names it, with a media query that
 * never matches: the browser then neither waits for it nor applies it. It has to stay named,
 * because code fetched later (the wallet, an order's page) lists it among what it needs and looks
 * in the page for exactly that link; finding none, it would try to fetch the file, and fail if
 * the file were gone. scripts/check-build.ts fails the build if the two ever come apart.
 */
function stylesInThePage(): Plugin {
  return {
    name: "styles-in-the-page",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const page = bundle["index.html"];
      if (page === undefined || page.type !== "asset" || typeof page.source !== "string") throw new Error("styles-in-the-page: the page is not in the build");
      const link = /<link rel="stylesheet"[^>]*href="\/(assets\/[^"]+\.css)"[^>]*>/.exec(page.source);
      if (link === null) throw new Error("styles-in-the-page: the page names no stylesheet");
      const sheet = bundle[link[1] ?? ""];
      if (sheet === undefined || sheet.type !== "asset") throw new Error("styles-in-the-page: the stylesheet is not in the build");
      const css = typeof sheet.source === "string" ? sheet.source : Buffer.from(sheet.source).toString("utf8");
      // Nothing in a stylesheet may end the element it is written into.
      if (/<\/style/i.test(css)) throw new Error("styles-in-the-page: the stylesheet cannot be written into the page as it is");
      page.source = page.source.replace(link[0], () => `<style>${css.trim()}</style>\n    <link rel="stylesheet" crossorigin href="/${link[1] ?? ""}" media="not all">`);
    },
  };
}

// The site is built into web/dist and served by our own server.
// In development Vite serves the pages and forwards /api to the server.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), stylesInThePage()],
  resolve: {
    alias: {
      // The wallet library can bring in extra kits (Coinbase, Base Account, Safe) from this package.
      // Each adds a script of its own to the page or opens a pop-up. None is wanted: the package is
      // replaced by an empty file, so not a line of them is in the built site.
      "@wagmi/connectors": path.join(import.meta.dirname, "src/wallet/no-extra-kits.ts"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://localhost:8787", changeOrigin: false } },
  },
});
