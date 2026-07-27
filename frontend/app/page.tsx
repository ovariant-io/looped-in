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
 */
export default function Landing() {
  return (
    <main className={styles.main}>
      <section className={styles.copy}>
        <BrandLogo className={styles.logo} priority />
        <p className={styles.eyebrow}>Your data · Your AI tools</p>
        <h1 className={styles.title}>
          Let&rsquo;s get your data Looped In
        </h1>
        <p className={styles.lede}>
          Everything you upload lives in one place — and connects straight to
          the AI assistants you already use, over a channel that only ever sees
          what you see.
        </p>
        <div className={styles.actions}>
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
        </div>
      </section>

      <div className={styles.scene}>
        <LoopScene />
      </div>
    </main>
  );
}
