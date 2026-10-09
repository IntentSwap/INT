// The layout every page of text shares: the Docs, the Terms, the Privacy Policy and the questions.
// Contents on the left (every page, and under the one being read its own sections, with the one
// on screen marked); the text in a column of about 68 characters; on a wide screen the page's own
// headings on the right; links to the page before and the page after at the foot.

import { ArrowLeft, ArrowRight, ChevronDown, Info, Link2, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { docPages, headingId, headingInView, neighbours, type DocPage } from "../lib/docs-logic.ts";
import { isPrivateMode } from "../lib/site-logic.ts";
import { useApp } from "../stores/app.ts";
import { Link } from "./Link.tsx";
import "../styles/prose.css";
import "../styles/docs.css";

interface Heading {
  id: string;
  title: string;
}

/** The headings of the page as it stands, read from the page itself, and which of them is being read. */
function useHeadings(article: React.RefObject<HTMLElement | null>, href: string): { headings: Heading[]; current: number } {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [current, setCurrent] = useState(0);
  useEffect(() => {
    const element = article.current;
    if (element === null) return;
    const read = () => {
      const found = [...element.querySelectorAll<HTMLElement>("h2[id]")].map((heading) => ({ id: heading.id, title: heading.dataset.title ?? heading.textContent ?? "" }));
      setHeadings((before) => (before.length === found.length && before.every((item, index) => item.id === found[index]?.id && item.title === found[index]?.title) ? before : found));
    };
    read();
    // A page's sections can arrive after it does (the list of chains; the example quote).
    const watcher = new MutationObserver(read);
    watcher.observe(element, { childList: true, subtree: true });
    return () => watcher.disconnect();
  }, [article, href]);

  useEffect(() => {
    const element = article.current;
    if (element === null) return;
    let frame = 0;
    const look = () => {
      frame = 0;
      const tops = [...element.querySelectorAll<HTMLElement>("h2[id]")].map((heading) => heading.getBoundingClientRect().top);
      const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2 && window.scrollY > 0;
      // The line is a little under the header that stays at the top of the screen.
      const next = headingInView(tops, 120, atEnd);
      if (next >= 0) setCurrent(next);
    };
    const ask = () => {
      if (frame === 0) frame = requestAnimationFrame(look);
    };
    look();
    window.addEventListener("scroll", ask, { passive: true });
    window.addEventListener("resize", ask);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", ask);
      window.removeEventListener("resize", ask);
    };
  }, [article, href, headings]);
  return { headings, current: Math.min(current, Math.max(0, headings.length - 1)) };
}

/** A link to a heading on this page. It scrolls there itself, because the router does not follow a "#". */
function Jump({ id, children, className, current }: { id: string; children: ReactNode; className?: string; current?: boolean }) {
  return (
    <a
      href={`#${id}`}
      className={className}
      aria-current={current ? "location" : undefined}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        window.history.replaceState(null, "", `#${id}`);
        document.getElementById(id)?.scrollIntoView({ block: "start" });
      }}
    >
      {children}
    </a>
  );
}

/** The contents: every page, in groups; under the page being read, its own sections. */
function Contents({ pages, href, headings, current }: { pages: readonly DocPage[]; href: string; headings: Heading[]; current: number }) {
  return (
    <>
      {(["Guide", "Legal"] as const).map((group) => (
        <div key={group} className="docs-group">
          <p className="docs-group-title">{group}</p>
          <ul>
            {pages.filter((page) => page.group === group).map((page) => (
              <li key={page.href}>
                <Link href={page.href} className="docs-page-link" aria-current={page.href === href ? "page" : undefined}>
                  {page.title}
                </Link>
                {page.href === href && headings.length > 0 ? (
                  <ul className="docs-sections">
                    {headings.map((heading, index) => (
                      <li key={heading.id}>
                        <Jump id={heading.id} className="docs-section-link" current={index === current}>
                          {heading.title}
                        </Jump>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

export function DocsLayout({ href, title, lead, children }: { href: string; title: string; lead?: ReactNode; children: ReactNode }) {
  const article = useRef<HTMLElement>(null);
  const { headings, current } = useHeadings(article, href);
  // The pages there are: the page on private routing is one of them only where swaps are routed privately.
  const pages = docPages(useApp((state) => isPrivateMode(state.config)));
  const page = pages.find((item) => item.href === href);
  const { previous, next } = neighbours(href, pages);

  // An address that ends in "#heading", opened directly: the heading exists only once the page has drawn.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id !== "") document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [href, headings.length]);

  return (
    <div className="docs">
      {/* On a narrow screen the contents fold into one line at the top of the page. */}
      <details className="docs-fold">
        <summary>
          <span>Contents</span>
          <ChevronDown className="fold-chevron" size={16} strokeWidth={1.5} aria-hidden="true" />
        </summary>
        <nav aria-label="Contents">
          <Contents pages={pages} href={href} headings={headings} current={current} />
        </nav>
      </details>
      <nav className="docs-contents" aria-label="Contents">
        <Contents pages={pages} href={href} headings={headings} current={current} />
      </nav>

      <article ref={article} className="prose docs-body">
        <header className="docs-head">
          <p className="docs-crumb muted">
            {page?.group === "Legal" ? "Legal" : "Docs"} <span aria-hidden="true">/</span> {title}
          </p>
          <h1>{title}</h1>
          {lead !== undefined ? <p className="docs-lead">{lead}</p> : null}
        </header>
        {children}
        <nav className="docs-turn" aria-label="More pages">
          {previous !== null ? (
            <Link href={previous.href} className="docs-turn-link" data-way="previous">
              <span className="docs-turn-way muted">
                <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />
                Previous
              </span>
              <span className="docs-turn-title">{previous.title}</span>
            </Link>
          ) : (
            <span />
          )}
          {next !== null ? (
            <Link href={next.href} className="docs-turn-link" data-way="next">
              <span className="docs-turn-way muted">
                Next
                <ArrowRight size={16} strokeWidth={1.5} aria-hidden="true" />
              </span>
              <span className="docs-turn-title">{next.title}</span>
            </Link>
          ) : null}
        </nav>
      </article>

      {headings.length > 0 ? (
        <nav className="docs-here" aria-label="On this page">
          <p className="docs-group-title">On this page</p>
          <ul>
            {headings.map((heading, index) => (
              <li key={heading.id}>
                <Jump id={heading.id} className="docs-section-link" current={index === current}>
                  {heading.title}
                </Jump>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}

/** One section of a page: a heading with its own address, and a link to that address beside it. */
export function DocSection({ title, id, children }: { title: string; id?: string; children: ReactNode }) {
  const anchor = id ?? headingId(title);
  return (
    <section className="prose-section" aria-labelledby={anchor}>
      <h2 id={anchor} data-title={title} tabIndex={-1}>
        {title}
        <Jump id={anchor} className="heading-anchor">
          <Link2 size={16} strokeWidth={1.5} aria-hidden="true" />
          <span className="sr-only">Link to this section</span>
        </Jump>
      </h2>
      {children}
    </section>
  );
}

/** Something to stop at: a warning, or a tip. A rule down its side and a tint; not a box. */
export function Callout({ tone, title, children }: { tone: "warning" | "tip"; title: string; children: ReactNode }) {
  return (
    <aside className="callout" data-tone={tone}>
      {tone === "warning" ? <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" /> : <Info size={16} strokeWidth={1.5} aria-hidden="true" />}
      <div>
        <p className="callout-title">{title}</p>
        {children}
      </div>
    </aside>
  );
}

/** A table in a frame of its own: on a narrow screen it is the frame that scrolls sideways, never the page. */
export function TableFrame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="table-frame" role="region" aria-label={label} tabIndex={0}>
      <table>{children}</table>
    </div>
  );
}
