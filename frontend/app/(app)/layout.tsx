import { UserButton } from "@clerk/nextjs";
import { currentUser } from "@clerk/nextjs/server";
import { Suspense } from "react";
import { AppShell } from "./app-shell";
import styles from "./app-shell.module.css";

/**
 * Layout for everything behind sign-in. The route group `(app)` contributes nothing to the
 * URL — /clients is still /clients — it exists only so these routes share the shell while
 * the landing page and the auth pages stay stand-alone under the root layout.
 */
export default function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <AppShell
      profile={
        <Suspense fallback={null}>
          <SidebarProfile />
        </Suspense>
      }
    >
      {children}
    </AppShell>
  );
}

/**
 * The rail's footer: the account control the header no longer carries.
 *
 * `currentUser()` is request-dynamic, which is why this sits behind its own Suspense
 * boundary — the rest of the shell is static and should not wait on it. There is no
 * signed-out branch: proxy.ts protects every route under this layout, so by the time
 * this renders there is always a session.
 */
async function SidebarProfile() {
  const user = await currentUser();
  const name = user?.fullName ?? user?.firstName ?? "Your account";
  const email = user?.primaryEmailAddress?.emailAddress ?? null;

  return (
    <>
      <UserButton />
      <span className={styles.account}>
        <span className={styles.accountName}>{name}</span>
        {email && <span className={styles.accountEmail}>{email}</span>}
      </span>
    </>
  );
}
