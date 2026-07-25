import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import { Suspense } from "react";
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
          lives in its own Suspense boundary (Cache Components is enabled). */}
      <Suspense
        fallback={<p className={styles.muted}>Calling the backend…</p>}
      >
        <BackendIdentity />
      </Suspense>
    </main>
  );
}

async function BackendIdentity() {
  const { getToken } = await auth();
  const token = await getToken();

  // Defense-in-depth: proxy.ts already redirects signed-out users to sign-in.
  if (!token) {
    return (
      <section className={`${styles.card} ${styles.warn}`}>
        <p className={styles.cardTitle}>No session token</p>
        <p className={styles.muted}>
          You don&apos;t have an active session. Try signing in again.
        </p>
      </section>
    );
  }

  const base = process.env.BACKEND_URL ?? "http://localhost:5114";

  let res: Response;
  try {
    res = await fetch(`${base}/me`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch (err) {
    const cause =
      err instanceof Error && err.cause ? (err.cause as { code?: string }) : undefined;
    const message = err instanceof Error ? err.message : String(err);
    const detail = cause?.code ? `${message} (${cause.code})` : message;
    const refused = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(
      `${message} ${cause?.code ?? ""}`,
    );
    return (
      <section className={`${styles.card} ${styles.error}`}>
        <p className={styles.cardTitle}>❌ Could not reach the backend</p>
        <p className={styles.muted}>
          <code>
            {base}/me
          </code>{" "}
          — {detail}
        </p>
        {refused ? (
          <p className={styles.hint}>
            The backend isn&apos;t running on the expected URL/port. Start it
            with the http profile (<code>dotnet run --project LoopedIn.Api
            --launch-profile http</code>, which listens on <code>5114</code>) or
            point <code>BACKEND_URL</code> at the right address.
          </p>
        ) : null}
      </section>
    );
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      // ignore unreadable bodies
    }
    return (
      <section className={`${styles.card} ${styles.error}`}>
        <p className={styles.cardTitle}>
          ❌ Backend rejected the request ({res.status})
        </p>
        {detail ? <p className={styles.muted}>{detail}</p> : null}
        {res.status === 401 ? (
          <p className={styles.hint}>
            401 — the token was rejected. Check that the backend&apos;s{" "}
            <code>Clerk:Authority</code> matches this frontend&apos;s Clerk
            instance (the same issuer the token was minted for).
          </p>
        ) : null}
      </section>
    );
  }

  const data = (await res.json()) as MeResponse;

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
