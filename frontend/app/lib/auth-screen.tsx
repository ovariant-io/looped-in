import Link from "next/link";
import type { ReactNode } from "react";
import { BrandLogo } from "./brand-logo";
import styles from "./auth-screen.module.css";

/**
 * The frame around Clerk's sign-in and sign-up widgets.
 *
 * These routes sit outside `(app)`, so they get no sidebar and no app header — which is
 * right, but left them as an unbranded widget floating on the page ground. The lockup gives
 * them the same front door the landing page has, and links back to it so a visitor who
 * arrived at /sign-in directly is not stuck there.
 */
export function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <main className={styles.main}>
      <Link href="/" className={styles.brand} aria-label="Looped In — home">
        <BrandLogo className={styles.logo} priority />
      </Link>
      {children}
    </main>
  );
}
