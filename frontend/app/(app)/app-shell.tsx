"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { BrandLogo } from "@/app/lib/brand-logo";
import styles from "./app-shell.module.css";

/** Stroke icons, drawn on a 24-grid so they line up at any size. */
function NavIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

// `end` marks a route matched exactly rather than by prefix — only /dashboard needs it,
// but stating it per item stops the next nested route from silently lighting up its parent.
const NAV_ITEMS = [
  {
    href: "/dashboard",
    label: "Dashboard",
    end: true,
    icon: (
      <NavIcon>
        <path d="m3 10 9-7 9 7" />
        <path d="M5 8.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5" />
        <path d="M9 21v-6h6v6" />
      </NavIcon>
    ),
  },
  {
    href: "/clients",
    label: "Clients",
    end: false,
    icon: (
      <NavIcon>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </NavIcon>
    ),
  },
  {
    href: "/campaigns",
    label: "Campaigns",
    end: false,
    icon: (
      <NavIcon>
        <path d="M22 2 11 13" />
        <path d="M22 2 15 22l-4-9-9-4z" />
      </NavIcon>
    ),
  },
  {
    href: "/documents",
    label: "Documents",
    end: false,
    icon: (
      <NavIcon>
        <path d="M14 3v4a1 1 0 0 0 1 1h4" />
        <path d="M19 8v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7z" />
        <path d="M9 13h6" />
        <path d="M9 17h4" />
      </NavIcon>
    ),
  },
  {
    href: "/connect",
    label: "Connect AI",
    end: false,
    icon: (
      <NavIcon>
        <path d="M9 3 10.4 7.6 15 9l-4.6 1.4L9 15l-1.4-4.6L3 9l4.6-1.4z" />
        <path d="M17 14l.85 2.15L20 17l-2.15.85L17 20l-.85-2.15L14 17l2.15-.85z" />
      </NavIcon>
    ),
  },
  {
    href: "/me",
    label: "My API identity",
    end: false,
    icon: (
      <NavIcon>
        <circle cx="12" cy="8" r="4" />
        <path d="M5.5 21a7 7 0 0 1 13 0" />
      </NavIcon>
    ),
  },
] as const;

/**
 * The signed-in chrome: a logo-only header over a fixed nav rail, with the rail becoming a
 * drawer under 1024px.
 *
 * The header carries the brand and nothing else — no nav, no auth controls. Navigation lives
 * in the rail and the account control lives in the rail's footer, which is why the header can
 * stay a single element wide enough for the lockup to sit at its natural size. The one thing
 * that joins it on small screens is the drawer toggle, because with the rail off-canvas there
 * is nowhere else for it to go.
 *
 * `profile` is a server-rendered slot passed down from the layout — the supported way to nest
 * server UI (which is what reads the Clerk session) inside a client component.
 *
 * Content is wrapped in a plain <div>, not <main>: every page under this shell already renders
 * its own <main>, and nesting them would be invalid.
 */
export function AppShell({
  profile,
  children,
}: {
  profile: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);

  // Close the drawer on navigation. Derived during render from the previous pathname rather
  // than in an effect, so it covers every route change including browser back/forward.
  const [navPathname, setNavPathname] = useState(pathname);
  if (pathname !== navPathname) {
    setNavPathname(pathname);
    setNavOpen(false);
  }

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.menuButton}
          onClick={() => setNavOpen((open) => !open)}
          aria-label="Open navigation"
          aria-expanded={navOpen}
          aria-controls="app-nav"
        >
          <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M4 6h16" />
            <path d="M4 12h16" />
            <path d="M4 18h16" />
          </svg>
        </button>
        <Link href="/dashboard" className={styles.brand} aria-label="Looped In — dashboard">
          <BrandLogo className={styles.logo} priority />
        </Link>
      </header>

      {navOpen && (
        <div
          className={styles.backdrop}
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        id="app-nav"
        className={`${styles.sidebar}${navOpen ? ` ${styles.open}` : ""}`}
      >
        <nav className={styles.nav} aria-label="Primary">
          {NAV_ITEMS.map((item) => {
            const active = item.end
              ? pathname === item.href
              : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`${styles.navItem}${active ? ` ${styles.active}` : ""}`}
                aria-current={active ? "page" : undefined}
              >
                {item.icon}
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className={styles.footer}>{profile}</div>
      </aside>

      <div className={styles.main}>{children}</div>
    </div>
  );
}
