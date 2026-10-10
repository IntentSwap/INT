import { Ghost, Menu, Moon, Sun, Wallet } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { BANNER_WORDS } from "../../../shared/banner.ts";
import { shortAddress } from "../lib/swap-logic.ts";
import { statsPageOn } from "../lib/stats-logic.ts";
import { navFor, navigate, navItems, usePath } from "../router.ts";
import { useApp } from "../stores/app.ts";
import { useGhost } from "../stores/ghost.ts";
import { useSheet } from "../stores/sheet.ts";
import { useToast } from "../stores/toast.ts";
import { useWallet } from "../stores/wallet.ts";
import { setTheme, useTheme } from "../theme.ts";
import { Wordmark } from "./Brand.tsx";
import { GhostSheet } from "./GhostSheet.tsx";
import { Link } from "./Link.tsx";
import { SocialLinks } from "./Social.tsx";

function ThemeToggle() {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  const label = `Switch to the ${next === "dark" ? "Dark" : "Light"} theme`;
  return (
    <button type="button" className="button-icon header-theme" onClick={() => setTheme(next)} aria-label={label} title={label}>
      {theme === "dark" ? <Sun size={20} strokeWidth={1.5} aria-hidden="true" /> : <Moon size={20} strokeWidth={1.5} aria-hidden="true" />}
    </button>
  );
}

/** The same switch as a line of the phone's menu, where the header has no room for it. The icon shows the theme a press brings. */
export function ThemeMenuItem() {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button type="button" className="menu-link menu-theme" onClick={() => setTheme(next)}>
      Switch theme
      {next === "dark" ? <Moon size={20} strokeWidth={1.5} aria-hidden="true" /> : <Sun size={20} strokeWidth={1.5} aria-hidden="true" />}
    </button>
  );
}

/**
 * A press of the Ghost mode switch, wherever it stands. Off, and not turned on since the page was
 * loaded: the sheet that explains the mode opens, and turning it on is its button. After that it
 * switches at once. On: it turns off (and the page loads itself again, see stores/ghost.ts).
 */
function pressGhost(): void {
  const ghost = useGhost.getState();
  const sheet = useSheet.getState();
  if (!ghost.on && !ghost.explained) {
    sheet.open("ghost");
    return;
  }
  // The phone's menu, when the press came from there, gives way: the change is to be seen.
  sheet.close();
  if (ghost.on) ghost.turnOff();
  else void ghost.turnOn();
}

/**
 * Ghost mode in the header. The switch stands beside the theme switch: a ghost, with its two words
 * where the header has the room, and no tooltip. While the mode is on, the pill stands where Connect
 * stood and stays in view at every width; the stylesheet draws the two as one capsule (ghost.css).
 * On a phone the switch itself is a line of the menu, and the pill carries its own ghost.
 */
function GhostDock() {
  const on = useGhost((state) => state.on);
  const fresh = useGhost((state) => state.fresh);
  return (
    <div className="ghost-dock" data-on={on || undefined} data-fresh={(on && fresh) || undefined}>
      <button type="button" className="ghost-switch" aria-pressed={on} aria-label="Ghost mode" onClick={pressGhost}>
        <Ghost size={20} strokeWidth={1.5} aria-hidden="true" />
        <span className="ghost-switch-words">Ghost mode</span>
      </button>
      {on ? (
        // What is read aloud begins with the words that are shown, then says that the mode is on and what a press does.
        <button type="button" className="ghost-pill" aria-label="Ghost mode is on. Turn off" onClick={pressGhost}>
          <Ghost className="ghost-pill-glyph" size={16} strokeWidth={1.5} aria-hidden="true" />
          Ghost mode
        </button>
      ) : null}
    </div>
  );
}

/** The same switch as a line of the phone's menu, where the header has no room for it. It says in a word whether the mode is on. */
export function GhostMenuItem() {
  const on = useGhost((state) => state.on);
  return (
    <button type="button" className="menu-link menu-ghost" aria-pressed={on} onClick={pressGhost}>
      Ghost mode
      <span className="menu-ghost-state" aria-hidden="true">
        {on ? "On" : "Off"}
        <Ghost size={20} strokeWidth={1.5} />
      </span>
    </button>
  );
}

function WalletButton() {
  const wallet = useWallet();
  if (wallet.status === "connected" && wallet.address !== null) {
    return (
      <button type="button" className="button-secondary button-wallet" onClick={() => void wallet.disconnect()} title={wallet.address}>
        <Wallet className="wide-only" size={16} strokeWidth={1.5} aria-hidden="true" />
        {/* Six…six at every width, as everywhere else an address is shortened. Below 768 px the icon makes way for it. */}
        <span className="mono">{shortAddress(wallet.address)}</span>
        {/* The name read aloud begins with what is shown, then says what it is and what a press does. */}
        <span className="sr-only">, connected wallet. Disconnect</span>
      </button>
    );
  }
  return (
    <button type="button" className="button-secondary button-wallet" onClick={() => void wallet.connect()} disabled={wallet.status === "connecting"} aria-busy={wallet.status === "connecting" || undefined}>
      <Wallet size={16} strokeWidth={1.5} aria-hidden="true" />
      <span>{wallet.status === "connecting" ? "Connecting…" : "Connect"}</span>
    </button>
  );
}

/** The site's pages, as links across the header. On a narrow screen they are in the menu instead. */
function HeaderNav() {
  const current = navFor(usePath());
  const statsOn = useApp((state) => statsPageOn(state.config));
  return (
    <nav className="nav" aria-label="Main">
      {navItems(statsOn).map((item) => (
        <Link key={item.href} href={item.href} className="nav-link" aria-current={current === item.href ? "page" : undefined}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

/** Opens the menu. Only on screens too narrow for the links themselves. */
function MenuButton() {
  const open = useSheet((state) => state.open);
  return (
    <button type="button" className="button-icon header-menu" onClick={() => open("menu")} aria-label="Menu" title="Menu" aria-haspopup="dialog">
      <Menu size={20} strokeWidth={1.5} aria-hidden="true" />
    </button>
  );
}

/** True once the page has scrolled under the header. The header then draws its veil (see shell.css). */
function useScrolled(): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const look = () => setScrolled(window.scrollY > 4);
    look();
    window.addEventListener("scroll", look, { passive: true });
    return () => window.removeEventListener("scroll", look);
  }, []);
  return scrolled;
}

export function Header({ extra }: { extra?: ReactNode }) {
  // Where the site cannot be used, there is nothing to connect a wallet to and nowhere to go.
  const usable = useApp((state) => state.boot !== "region");
  // On a narrow phone a wallet's address, or "Connecting…", takes the room the name would have (see shell.css).
  const walletStatus = useWallet((state) => state.status);
  const scrolled = useScrolled();
  // In Ghost mode there is no wallet and nothing to connect: the mode's pill stands in Connect's place.
  const ghost = useGhost((state) => state.on);
  const explaining = useSheet((state) => state.current === "ghost");
  return (
    <>
      <header className="header" data-wallet={ghost ? "disconnected" : walletStatus} data-scrolled={scrolled || undefined}>
        <Wordmark />
        {usable ? <HeaderNav /> : null}
        {/* To the right: where IntentSwap is found elsewhere (on a phone these are in the menu), the theme, Ghost mode, the wallet. */}
        <div className="header-actions">
          {extra}
          {usable ? <SocialLinks where="header" /> : null}
          <ThemeToggle />
          <GhostDock />
          {usable && !ghost ? <WalletButton /> : null}
          {usable ? <MenuButton /> : null}
        </div>
      </header>
      {/* The sheet that explains the mode before it is first turned on. Like every sheet, it lies over the whole page. */}
      {explaining ? <GhostSheet /> : null}
    </>
  );
}

/** The service banner: shown when swaps are paused or the provider is struggling. */
/**
 * The banner the server wrote into the page it sent (see server/static.ts), read once before the
 * app draws over it. Until the app has heard from the server itself, it shows this same banner, so
 * that the banner never goes away and comes back.
 */
const servedBanner: string[] = typeof document === "undefined" ? [] : [...document.querySelectorAll(".first-paint .banner p")].map((line) => line.textContent ?? "").filter((line) => line !== "");

export function Banner() {
  const health = useApp((state) => state.health);
  const waiting = useApp((state) => state.boot === "loading");
  if (waiting && servedBanner.length > 0) {
    return (
      <div className="banner" role="status">
        {servedBanner.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    );
  }
  if (health !== "paused" && health !== "degraded") return null;
  return (
    <div className="banner" role="status">
      {health === "paused" ? <p>{BANNER_WORDS.paused}</p> : null}
      {health === "degraded" ? <p>{BANNER_WORDS.degraded}</p> : null}
    </div>
  );
}

function FooterLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="draw"
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(href);
        if (href.includes("#")) document.getElementById(href.split("#")[1] ?? "")?.scrollIntoView();
      }}
    >
      {children}
    </a>
  );
}

function contactHref(contact: string): string | null {
  if (contact.startsWith("https://")) return contact;
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact)) return `mailto:${contact}`;
  return null;
}

export function Footer() {
  const config = useApp((state) => state.config);
  const usable = useApp((state) => state.boot !== "region");
  const contact = config?.supportContact ?? null;
  const href = contact === null ? null : contactHref(contact);
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-brand">
          <Wordmark />
          <p className="footer-note muted">Swaps run on NEAR Intents.</p>
          {usable ? <SocialLinks where="footer" /> : null}
        </div>
        <nav className="footer-links" aria-label="Footer">
          <FooterLink href="/docs">Docs</FooterLink>
          <FooterLink href="/terms">Terms</FooterLink>
        <FooterLink href="/privacy">Privacy</FooterLink>
        {/* The questions are on the home page, which a visitor the site cannot serve does not get. */}
        {usable ? <FooterLink href="/#faq">FAQ</FooterLink> : null}
        {contact !== null ? (
          href !== null ? (
            <a href={href} className="draw" rel="noopener noreferrer">
              Support: {contact.replace(/^https:\/\//, "")}
            </a>
          ) : (
            <span>Support: {contact}</span>
          )
        ) : null}
        </nav>
      </div>
    </footer>
  );
}

export function Toast() {
  const message = useToast((state) => state.message);
  return (
    <div className="toast-area" role="status" aria-live="polite">
      {message !== null ? <div className="toast">{message}</div> : null}
    </div>
  );
}

/** A plain full-page message: headline, cause, and at most one action. */
/**
 * A page that has one thing to say (not found, not available, cannot be reached). It opens as the
 * site's other single-purpose pages do: a small tag with its rule, a large title, a line beneath.
 * `inCard` is for the swap page, where the notice stands in the swap card's own frame, at the card's
 * width and in its place, so the page keeps its shape while the card cannot be used.
 */
export function Notice({ title, children, action, inCard = false }: { title: string; children: ReactNode; action?: ReactNode; inCard?: boolean }) {
  if (inCard) {
    return (
      <section className="notice-card">
        <h1 className="notice-card-title">{title}</h1>
        <div className="notice-card-body muted">{children}</div>
        {action}
      </section>
    );
  }
  return (
    <section className="notice-page">
      <header className="notice-head">
        <p className="notice-tag mono">IntentSwap</p>
        <h1 className="notice-title">{title}</h1>
        <div className="notice-lead muted">{children}</div>
      </header>
      {action}
    </section>
  );
}
