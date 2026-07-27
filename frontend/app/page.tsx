import { SignInButton, SignUpButton } from "@clerk/nextjs";
import { BrandLogo } from "./lib/brand-logo";
import { LoopScene } from "./loop-scene";
import styles from "./page.module.css";

/**
 * The signed-out front door — a stand-alone screen, not a page inside the app.
 *
 * It renders straight under the root layout, so it carries none of the signed-in chrome:
 * no sidebar, no app header, nothing but the brand and the two ways in. A signed-in visitor
 * never reaches it — `proxy.ts` redirects "/" to /dashboard before this renders, which is
 * also what keeps this page free of `auth()` and therefore prerenderable.
 *
 * There is deliberately no pitch copy: this is a private tool with a known audience, not a
 * product page, so the screen is a branded door rather than an argument for walking through
 * it. That is also why the layout is one centred column — with the copy gone there is no
 * second column to balance the scene against.
 *
 * The lockup carries the <h1>. Removing the headline would otherwise leave the page with no
 * heading at all, and the brand *is* what this page is about; `BrandLogo` renders an <img>
 * with alt text, so the heading has a real accessible name.
 */
export default function Landing() {
  return (
    <main className={styles.main}>
      <header className={styles.head}>
        <h1 className={styles.brand}>
          <BrandLogo className={styles.logo} priority />
        </h1>
        <p className={styles.eyebrow}>Your data · Your AI tools</p>
      </header>

      <div className={styles.scene}>
        <LoopScene />
      </div>

      <nav className={styles.actions} aria-label="Get started">
        <SignUpButton>
          <button className={`${styles.button} ${styles.primary}`}>
            Sign up
          </button>
        </SignUpButton>
        <SignInButton>
          <button className={`${styles.button} ${styles.ghost}`}>
            Sign in
          </button>
        </SignInButton>
      </nav>
    </main>
  );
}
