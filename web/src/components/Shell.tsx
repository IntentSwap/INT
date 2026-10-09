import { Menu, Moon, Sun, Wallet } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { BANNER_WORDS } from "../../../shared/banner.ts";
import { shortAddress } from "../lib/swap-logic.ts";
import { NAV, navFor, navigate, usePath } from "../router.ts";
import { useApp } from "../stores/app.ts";
import { useSheet } from "../stores/sheet.ts";
import { useToast } from "../stores/toast.ts";
import { useWallet } from "../stores/wallet.ts";
import { setTheme, useTheme } from "../theme.ts";
import { Wordmark } from "./Brand.tsx";
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

function WalletButton() {
  const wallet = useWallet();
  if (wallet.status === "connected" && wallet.address !== null) {
    return (
      <button type="button" className="button-secondary button-wallet" onClick={() => void wallet.disconnect()} title={wallet.address}>
        <Wallet className="wide-only" size={16} strokeWidth={1.5} aria-hidden="true" />
        {/* Six…six at every width, as everywhere else an address is shortened. On a phone the icon makes way for it. */}
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

/** The four pages, as links across the header. On a narrow screen they are in the menu instead. */
function HeaderNav() {
  const current = navFor(usePath());
  return (
    <nav className="nav" aria-label="Main">
      {NAV.map((item) => (
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
  return (
    <header className="header" data-wallet={walletStatus} data-scrolled={scrolled || undefined}>
      <Wordmark />
      {usable ? <HeaderNav /> : null}
      {/* To the right: where IntentSwap is found elsewhere (on a phone these are in the menu), the theme, the wallet. */}
      <div className="header-actions">
        {extra}
        {usable ? <SocialLinks where="header" /> : null}
        <ThemeToggle />
        {usable ? <WalletButton /> : null}
        {usable ? <MenuButton /> : null}
      </div>
    </header>
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
          {contact !== null ? <p className="footer-note muted">Support never asks for your seed phrase and never messages you first.</p> : null}
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
export function Notice({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="notice-page">
      <h1>{title}</h1>
      <div className="notice-page-body muted">{children}</div>
      {action}
    </section>
  );
}
