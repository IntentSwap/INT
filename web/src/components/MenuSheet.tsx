import { Check } from "lucide-react";
import { statsPageOn } from "../lib/stats-logic.ts";
import { navFor, navItems, usePath } from "../router.ts";
import { useApp } from "../stores/app.ts";
import { useSheet } from "../stores/sheet.ts";
import { Link } from "./Link.tsx";
import { Sheet } from "./Sheet.tsx";
import { ThemeMenuItem } from "./Shell.tsx";
import { SocialLinks } from "./Social.tsx";

/** The site's pages, on a screen too narrow to list them in the header; and, at its foot, the three icon links the header has no room for. */
export function MenuSheet() {
  const close = useSheet((state) => state.close);
  const current = navFor(usePath());
  const statsOn = useApp((state) => statsPageOn(state.config));

  return (
    <Sheet title="Menu" onClose={close}>
      <nav className="menu" aria-label="Main">
        <ul className="menu-list">
          {navItems(statsOn).map((item) => (
            <li key={item.href}>
              <Link href={item.href} className="menu-link" aria-current={current === item.href ? "page" : undefined} onNavigate={close}>
                {item.label}
                {current === item.href ? (
                  <>
                    <Check size={20} strokeWidth={1.5} aria-hidden="true" />
                    <span className="sr-only">(this page)</span>
                  </>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
        <div className="menu-rule" aria-hidden="true" />
        {/* The questions: always within reach here, also while the floating Help button is out of the way. */}
        <Link href="/#faq" className="menu-link" onNavigate={close}>
          Help
        </Link>
        {/* On a phone the header's room goes to the site's name, and the theme is changed from here. */}
        <ThemeMenuItem />
      </nav>
      <SocialLinks where="menu" />
    </Sheet>
  );
}
