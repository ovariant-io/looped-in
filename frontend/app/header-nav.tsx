"use client";

import { SignInButton, SignUpButton, UserButton, useAuth } from "@clerk/nextjs";
import Link from "next/link";
import styles from "./header.module.css";

/**
 * Auth-reactive header navigation (client component).
 *
 * Why client: Clerk's *server* control components read `await auth()` once at
 * render time, so after a client-side sign-in the header stayed on the signed-out
 * buttons until a full reload. Reading Clerk's live client state via `useAuth()`
 * lets the header flip the instant the session changes — no refresh.
 *
 * Why the `initialSignedIn` seed: Clerk's client hooks report `isLoaded: false`
 * until Clerk's JS boots, and a prerendered shell has no per-request state to fall
 * back on — which left the nav blank on first paint. The parent server slot resolves
 * the real auth state per request and passes it in, so the correct buttons render
 * immediately (and hydration matches); once Clerk loads, live state takes over.
 */
export function HeaderNav({ initialSignedIn }: { initialSignedIn: boolean }) {
  const { isLoaded, userId } = useAuth();
  const signedIn = isLoaded ? userId != null : initialSignedIn;

  return (
    <nav className={styles.nav}>
      {signedIn ? (
        <>
          <Link href="/documents" className={styles.navLink}>
            Documents
          </Link>
          <Link href="/me" className={styles.navLink}>
            My API identity
          </Link>
          <Link href="/connect" className={styles.navLink}>
            Connect AI
          </Link>
          <UserButton />
        </>
      ) : (
        <>
          <SignInButton>
            <button className={`${styles.button} ${styles.ghost}`}>
              Sign in
            </button>
          </SignInButton>
          <SignUpButton>
            <button className={`${styles.button} ${styles.primary}`}>
              Sign up
            </button>
          </SignUpButton>
        </>
      )}
    </nav>
  );
}
