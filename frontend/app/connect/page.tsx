import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { CopyField } from "./copy-field";
import styles from "./connect.module.css";

export const metadata: Metadata = {
  title: "Connect an AI assistant",
  description:
    "Add the Looped In MCP server to Claude and other MCP clients — signed in as you, over an authenticated channel.",
};

// The tools the MCP server exposes today. This is the scaffold's surface: enough to prove
// the auth chain end to end. Extend it alongside mcp/looped_in_mcp/tools/.
const TOOLS = [
  {
    name: "whoami",
    what: "Echoes the identity on your session token — user id, email, and the Clerk instance that issued it.",
    ask: "Who am I on Looped In?",
  },
  {
    name: "my_api_identity",
    what: "Passes your token through to the Looped In API's protected /me endpoint and returns what the API itself saw.",
    ask: "What does the Looped In API see me as?",
  },
];

export default function ConnectPage() {
  return (
    <main className={styles.main}>
      <h1 className={styles.title}>Connect an AI assistant</h1>
      <p className={styles.intro}>
        Looped In runs an <strong>MCP server</strong> — a small, authenticated
        endpoint that lets Claude (or any MCP client) act on your behalf. You
        sign in with the same Looped In account you&apos;re using right now, so
        the assistant sees exactly what you can see and nothing more.
      </p>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>1. Your connection link</h2>
        <p className={styles.muted}>
          Copy this — you&apos;ll paste it into your assistant in the next step.
        </p>
        <Suspense fallback={<p className={styles.muted}>Loading the link…</p>}>
          <ConnectorLink />
        </Suspense>
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>2. Add it as a connector</h2>
        <ol className={styles.steps}>
          <li>
            In <strong>Claude Desktop</strong>, open{" "}
            <em>Settings → Connectors</em> and choose{" "}
            <em>Add custom connector</em>.
          </li>
          <li>
            Paste the link above. Leave the OAuth client ID and secret{" "}
            <strong>empty</strong> — the connector registers itself
            automatically.
          </li>
          <li>
            A sign-in window opens. Use your usual Looped In account, then
            choose <em>Allow</em> on the consent screen.
          </li>
          <li>
            That&apos;s it. Start a chat and try one of the questions below.
          </li>
        </ol>
        <p className={styles.hint}>
          Other MCP clients work the same way — anywhere that accepts a remote
          MCP server URL, this link is the whole configuration.
        </p>
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>3. What it can do</h2>
        <dl className={styles.tools}>
          {TOOLS.map((tool) => (
            <div key={tool.name} className={styles.tool}>
              <dt>
                <code>{tool.name}</code>
              </dt>
              <dd>
                {tool.what} <span className={styles.ask}>“{tool.ask}”</span>
              </dd>
            </div>
          ))}
        </dl>
        <p className={styles.hint}>
          A short list on purpose — this is the scaffold. Every tool added to
          the server shows up in your assistant automatically, no reconnecting.
        </p>
      </section>

      <details className={styles.troubleshooting}>
        <summary>If it doesn&apos;t connect</summary>
        <ul>
          <li>
            <strong>No sign-in window appears.</strong> The link must be the
            full URL ending in <code>/mcp</code>, and your client needs to reach
            it over HTTPS.
          </li>
          <li>
            <strong>Signed in, but every tool returns 401.</strong> The token
            was issued by a different Clerk instance than the server trusts —
            check that the connector points at this environment&apos;s link.
          </li>
          <li>
            <strong>Tools answer, but the API ones fail.</strong> The server
            reached Looped In and was refused; the error text names the status
            and reason.
          </li>
        </ul>
      </details>
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
