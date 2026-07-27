import Link from "next/link";
import styles from "./clients.module.css";

/**
 * The failure states both `/clients` and `/clients/[id]` can land in, rendered once.
 *
 * `callBackend` returns rather than throws, so a dependency that is merely unconfigured shows an
 * explanation instead of tripping the error boundary — and the API's problem+json `detail` is
 * written to be read by a person, so it is shown verbatim. The status-specific hints below say
 * what to *do*, which the API cannot know.
 */
export function ApiError({
  status,
  error,
  what = "clients",
}: {
  status: number;
  error: string;
  what?: string;
}) {
  return (
    <section className={`${styles.card} ${styles.error}`}>
      <p className={styles.cardTitle}>{title(status, what)}</p>
      <p className={styles.muted}>{error}</p>

      {status === 503 ? (
        <p className={styles.hint}>
          The API is running but has no usable database. Set <code>DATABASE_URL</code>{" "}
          in <code>backend/.env.local</code> for local development — deployed stages
          get it from the SST stack. If it <em>is</em> set, the message above is
          coming from the startup migration, and the API logs carry the detail.
        </p>
      ) : null}

      {status === 401 ? (
        <p className={styles.hint}>
          401 — the token was rejected. Check that the backend&apos;s{" "}
          <code>Clerk:Authority</code> matches this frontend&apos;s Clerk instance.
        </p>
      ) : null}

      {status === 404 ? (
        <p className={styles.hint}>
          It may have been deleted by someone else — the list is shared by everyone
          signed in. <Link href="/clients">Back to all clients</Link>.
        </p>
      ) : null}
    </section>
  );
}

function title(status: number, what: string): string {
  if (status === 503) {
    return "🗄️ The client database isn't available";
  }
  if (status === 404) {
    return "🔍 That client no longer exists";
  }
  return `❌ Could not load ${what}${status ? ` (${status})` : ""}`;
}
