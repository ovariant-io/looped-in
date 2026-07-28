import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { ClientGuide } from "./client-guide";
import { CopyField } from "./copy-field";
import styles from "./connect.module.css";

export const metadata: Metadata = {
  title: "Connect an AI assistant",
  description:
    "Add the Looped In MCP server to Claude Desktop and other MCP clients — signed in as you, over an authenticated channel.",
};

export default function ConnectPage() {
  return (
    <main className={styles.main}>
      <h1 className={styles.title}>Connect an AI assistant</h1>
      <p className={styles.intro}>
        Looped In runs an <strong>MCP server</strong> — a small, authenticated
        endpoint that lets Claude (or any MCP client) act on your behalf. You
        sign in with the same Looped In account you&apos;re using right now, so
        the assistant sees exactly what you can see and nothing more. Pick the
        client you&apos;re connecting, link it, then hand it the prompt that
        teaches it the ropes.
      </p>
      {/* The guide is a client component (the toggle); the link is resolved on
          the server per request. Passing it as a rendered slot keeps
          `connection()` server-side and the toggle instant. */}
      <ClientGuide
        connectorLink={
          <Suspense fallback={<p className={styles.muted}>Loading the link…</p>}>
            <ConnectorLink />
          </Suspense>
        }
      />
    </main>
  );
}

async function ConnectorLink() {
  // MCP_URL is injected at runtime — by infra/services/web.ts in the cloud, by
  // docker-compose.yml locally. `connection()` stops prerendering here so the value is read
  // per request rather than baked in at build time (Next reads server env vars at runtime
  // only during dynamic rendering). It is not NEXT_PUBLIC_ for exactly that reason.
  await connection();
  const url = process.env.MCP_URL?.trim();

  if (!url) {
    return (
      <p className={styles.unset}>
        No MCP server is configured for this environment. The link appears here
        once the stack is deployed — or set <code>MCP_URL</code> when running
        locally.
      </p>
    );
  }

  return <CopyField value={url} label="connection link" />;
}
