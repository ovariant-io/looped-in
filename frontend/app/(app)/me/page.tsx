import type { Metadata } from "next";
import { Suspense } from "react";
import { backendUrl, callBackend } from "@/app/lib/backend";
import styles from "./me.module.css";

export const metadata: Metadata = {
  title: "My API identity",
  description: "Server-side smoke test of the Clerk → .NET backend trust chain",
};

type MeResponse = {
  userId?: string | null;
  email?: string | null;
  claims?: { type: string; value: string }[];
};

export default function MePage() {
  return (
    <main className={styles.main}>
      <h1 className={styles.title}>My API identity</h1>
      <p className={styles.intro}>
        This page reads your Clerk session token on the <strong>server</strong>{" "}
        and calls the protected <code>GET /me</code> endpoint on the .NET
        backend. A success below proves the full trust chain: a token minted by
        Clerk on the frontend, sent server-side, and validated by the API
        against Clerk&apos;s JWKS.
      </p>
      {/* auth() + the no-store fetch are request-dynamic, so the dynamic work
          lives in its own Suspense boundary. Cache Components is currently off
          (see next.config.ts); the boundary is kept so it can be re-enabled. */}
      <Suspense
        fallback={<p className={styles.muted}>Calling the backend…</p>}
      >
        <BackendIdentity />
      </Suspense>
    </main>
  );
}

async function BackendIdentity() {
  // Same server-side seam the /documents page uses: it reads the Clerk token, calls
  // BACKEND_URL, and reports transport failures as status 0 rather than throwing.
  const result = await callBackend<MeResponse>("/me");

  if (!result.ok) {
    if (result.status === 0) {
      return (
        <section className={`${styles.card} ${styles.error}`}>
          <p className={styles.cardTitle}>❌ Could not reach the backend</p>
          <p className={styles.muted}>
            <code>{backendUrl()}/me</code> — {result.error}
          </p>
        </section>
      );
    }

    return (
      <section className={`${styles.card} ${styles.error}`}>
        <p className={styles.cardTitle}>
          ❌ Backend rejected the request ({result.status})
        </p>
        <p className={styles.muted}>{result.error}</p>
        {result.status === 401 ? (
          <p className={styles.hint}>
            401 — the token was rejected. Check that the backend&apos;s{" "}
            <code>Clerk:Authority</code> matches this frontend&apos;s Clerk
            instance (the same issuer the token was minted for).
          </p>
        ) : null}
      </section>
    );
  }

  const data = result.data;

  return (
    <section className={`${styles.card} ${styles.ok}`}>
      <p className={styles.cardTitle}>
        ✅ The backend validated your Clerk token
      </p>
      <dl className={styles.identity}>
        <div className={styles.row}>
          <dt>User ID</dt>
          <dd>
            <code>{data.userId ?? "—"}</code>
          </dd>
        </div>
        <div className={styles.row}>
          <dt>Email</dt>
          <dd>
            <code>{data.email ?? "—"}</code>
          </dd>
        </div>
      </dl>
      {data.claims && data.claims.length > 0 ? (
        <details className={styles.claims}>
          <summary>Claims the API saw ({data.claims.length})</summary>
          <pre>{JSON.stringify(data.claims, null, 2)}</pre>
        </details>
      ) : null}
    </section>
  );
}
