import Link from "next/link";
import styles from "./clients.module.css";

/**
 * The failure states the database-backed screens can land in, rendered once. Written for
 * `/clients` and reused by `/campaigns` — the two share the API's database gate, so their 503 /
 * 401 / 404 shapes are identical and `what` + the back link are the only differences.
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
  backHref = "/clients",
  backLabel = "Back to all clients",
}: {
  status: number;
  error: string;
  what?: string;
  backHref?: string;
  backLabel?: string;
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
          signed in. <Link href={backHref}>{backLabel}</Link>.
        </p>
      ) : null}
    </section>
  );
}

function title(status: number, what: string): string {
  if (status === 503) {
    return "🗄️ The database isn't available";
  }
  if (status === 404) {
    // `what` is "this client" / "this campaign" on the pages that can 404 — lists never do.
    return `🔍 ${what.charAt(0).toUpperCase()}${what.slice(1)} no longer exists`;
  }
  return `❌ Could not load ${what}${status ? ` (${status})` : ""}`;
}
