import { Component, lazy, Suspense, useEffect, type ReactNode } from "react";
import { SecondaryButton } from "./components/Button.tsx";
import { Banner, Footer, Header, Notice, Toast } from "./components/Shell.tsx";
import { SwapPage } from "./pages/SwapPage.tsx";
import { docExists } from "./lib/docs-logic.ts";
import { isPrivateMode } from "./lib/site-logic.ts";
import { matchRoute, navigate, usePath, type Route } from "./router.ts";
import { useApp } from "./stores/app.ts";
import { HelpButton, TokenSection } from "./components/Home.tsx";
import { MenuSheet } from "./components/MenuSheet.tsx";
import { useSheet } from "./stores/sheet.ts";
import { useTokens } from "./stores/tokens.ts";

// The test page is only ever loaded when someone opens /states.
const StatesPage = lazy(() => import("./pages/StatesPage.tsx"));
// The order page is fetched when an order is opened.
const OrderPage = lazy(() => import("./pages/OrderPage.tsx"));
// Long pages of text are fetched when opened, so they add nothing to the swap page.
const TermsPage = lazy(() => import("./pages/LegalPages.tsx").then((pages) => ({ default: pages.TermsPage })));
const PrivacyPage = lazy(() => import("./pages/LegalPages.tsx").then((pages) => ({ default: pages.PrivacyPage })));
// The pages behind the header's links are fetched when opened too.
const TrackPage = lazy(() => import("./pages/TrackPage.tsx"));
const DocsPage = lazy(() => import("./pages/DocsPage.tsx"));
const RewardsPage = lazy(() => import("./pages/RewardsPage.tsx"));

/**
 * Catches a page that could not be drawn. The usual cause is that its code could not be fetched:
 * the connection dropped just as a link was pressed. Without this the whole site would go blank.
 * The page says what happened and offers to reload, which is also what puts it right; going to
 * another page clears it.
 */
class PageBoundary extends Component<{ resetKey: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidUpdate(previous: { resetKey: string }): void {
    if (previous.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false });
  }
  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <>
        <main className="main" id="main">
          <Notice title="This page could not be loaded." action={<SecondaryButton onClick={() => window.location.reload()}>Reload</SecondaryButton>}>
            <p>Check your connection, then reload.</p>
          </Notice>
        </main>
        <Footer />
      </>
    );
  }
}

export function App() {
  const path = usePath();
  const boot = useApp((state) => state.boot);
  // One page of the documentation exists only where swaps are routed privately. Anywhere else its
  // address is no page at all, like any other address the site does not know.
  const privateOn = useApp((state) => isPrivateMode(state.config));
  const matched = matchRoute(path);
  const route: Route = matched.page === "docs" && !docExists(matched.slug, privateOn) && boot !== "loading" ? { page: "not-found" } : matched;
  const loadApp = useApp((state) => state.load);
  const checkHealth = useApp((state) => state.checkHealth);
  const loadTokens = useTokens((state) => state.load);
  const sheet = useSheet((state) => state.current);
  const tokenAddress = useApp((state) => state.config?.tokenAddress ?? null);

  useEffect(() => {
    void loadApp();
    if (route.page === "states") return;
    void loadTokens();
    const timer = setInterval(() => {
      if (!document.hidden) void checkHealth();
    }, 60_000);
    return () => clearInterval(timer);
  }, [loadApp, loadTokens, checkHealth, route.page === "states"]);

  // A tool for looking over the components, never part of the live site: shown only where the server says test pages exist.
  const testPages = useApp((state) => state.config?.testPages ?? false);
  if (route.page === "states" && testPages) {
    return (
      <Suspense fallback={null}>
        <StatesPage />
      </Suspense>
    );
  }

  let page;
  // Where the site cannot be used, the Terms and the Privacy page can still be read: they are what
  // says who may use it and what is kept, and their links are the only ones the footer offers there.
  if (boot === "region" && route.page !== "terms" && route.page !== "privacy") {
    page = (
      <Notice title="Not available in your region.">
        <p>IntentSwap can't be used from where you are.</p>
      </Notice>
    );
  } else if (boot === "offline" && route.page !== "terms" && route.page !== "privacy") {
    // (The Terms and the Privacy page need nothing from the server, and stay readable.)
    page = (
      <Notice
        title="Can't reach the service."
        action={
          <SecondaryButton
            onClick={() => {
              // Everything that failed with the connection is asked for again, not only the first thing.
              void loadApp();
              void loadTokens();
            }}
          >
            Try again
          </SecondaryButton>
        }
      >
        <p>Check your connection, then try again.</p>
      </Notice>
    );
  } else if (route.page === "swap") {
    page = <SwapPage />;
  } else if (route.page === "order") {
    page = <OrderPage id={route.id} />;
  } else if (route.page === "docs" && !docExists(route.slug, privateOn)) {
    // Whether this page exists is not known until the server has said how swaps are routed.
    page = <p className="muted">Loading…</p>;
  } else if (route.page === "track" || route.page === "docs" || route.page === "rewards") {
    page = route.page === "track" ? <TrackPage /> : route.page === "docs" ? <DocsPage slug={route.slug} /> : <RewardsPage />;
  } else if (route.page === "token" && boot === "loading") {
    // Whether this page exists is not known until the server has said whether the token has an address.
    page = <p className="muted">Loading…</p>;
  } else if (route.page === "token" && tokenAddress !== null) {
    // The token's facts on a page of their own. Until the token's address is set, this address is no page at all.
    page = (
      <div className="token-page">
        <TokenSection ownPage />
      </div>
    );
  } else if (route.page === "terms" || route.page === "privacy") {
    page = route.page === "terms" ? <TermsPage /> : <PrivacyPage />;
  } else {
    // An address that is no page: also the token's page while the token has no address, and the page of component states on the live site.
    page = (
      <Notice title="Page not found." action={<SecondaryButton onClick={() => navigate("/")}>Go to the swap page</SecondaryButton>}>
        <p>There is nothing at this address.</p>
      </Notice>
    );
  }

  return (
    <div className="app" data-page={route.page}>
      <Banner />
      <Header />
      {/* A page that is still being fetched has no footer under it yet: the footer arrives with the
          page, in its place, and is never seen to jump down from under "Loading…". */}
      <PageBoundary resetKey={path}>
        <Suspense
          fallback={
            <main className="main" id="main">
              <p className="muted">Loading…</p>
            </main>
          }
        >
          <main className="main" id="main">
            {page}
          </main>
          <Footer />
        </Suspense>
      </PageBoundary>
      <Toast />
      {/* The questions are on the home page, and again at the foot of the docs. */}
      {boot === "ready" ? <HelpButton href={route.page === "docs" ? "/docs#faq" : "/#faq"} /> : null}
      {sheet === "menu" ? <MenuSheet /> : null}
    </div>
  );
}
