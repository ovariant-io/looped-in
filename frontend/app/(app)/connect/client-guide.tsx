"use client";

import { useState, type ReactNode } from "react";
import { ASSISTANT_PROMPT } from "./assistant-prompt";
import { CopyBlock } from "./copy-field";
import styles from "./connect.module.css";

/**
 * The per-client connection guide, switched by a toggle. Client component for
 * the toggle state only — the connector link is resolved on the server
 * (page.tsx reads MCP_URL per request) and arrives here as a rendered slot, so
 * selecting a client never refetches anything.
 */

const AI_CLIENTS = [
  { id: "claude-desktop", label: "Claude Desktop" },
  { id: "other", label: "Other MCP clients" },
] as const;

type AiClientId = (typeof AI_CLIENTS)[number]["id"];

// The tools the MCP server exposes today, most useful first. Extend it
// alongside mcp/looped_in_mcp/tools/ — and alongside assistant-prompt.ts,
// which describes the same surface to the assistant itself.
const TOOLS = [
  {
    name: "list_clients",
    what: "Pages through the shared client list, with search, industry and status filters.",
    ask: "Which clients are still in discussion?",
  },
  {
    name: "get_client",
    what: "One client in full — contacts, website, notes, and the lifecycle detail the list omits.",
    ask: "What do we know about Acme?",
  },
  {
    name: "list_client_details",
    what: "The bulk read — a page of clients in full, each with contacts and its latest logged touch, in one call.",
    ask: "Draft personalized outreach for every lead we haven't touched lately.",
  },
  {
    name: "get_client_status_history",
    what: "The append-only audit trail of a client's status changes, and who made each move.",
    ask: "When did Acme become an active client?",
  },
  {
    name: "list_client_interactions",
    what: "A client's outreach log — every recorded call, email and meeting, newest first.",
    ask: "When did we last touch base with Acme?",
  },
  {
    name: "add_client_interaction",
    what: "Logs a touch on a client — kind, date, summary, and an optional follow-up date.",
    ask: "Log that I called Acme today and need to follow up next Friday.",
  },
  {
    name: "change_client_status",
    what: "Moves a client through the pipeline — the one writer of status, with the audit trail kept for you.",
    ask: "Mark Acme as an active client.",
  },
  {
    name: "create_client / update_client",
    what: "Adds a client, or edits its fields — updates send only what changed and detect concurrent edits.",
    ask: "Add Acme Mining as a lead, sourced from the Perth expo.",
  },
  {
    name: "add_client_contact / update_client_contact",
    what: "Adds or edits the people on a client — a contact needs at least a name or an email.",
    ask: "Add Jo Chen, jo@acme.example, as Acme's procurement lead.",
  },
  {
    name: "list_campaigns / get_campaign",
    what: "The EDM campaigns and their per-client drafts, with per-state counts as each campaign's progress.",
    ask: "How is the July re-engagement campaign going?",
  },
  {
    name: "add_campaign_message / update_campaign_message",
    what: "Drafts one personalized email per client into a campaign — one draft per client, revised in place.",
    ask: "Draft a re-engagement email for every client in discussion.",
  },
  {
    name: "set_campaign_message_state",
    what: "Records a draft's outcome — approved, skipped, or sent, which also logs the touch on the client.",
    ask: "Mark Acme's campaign email as sent.",
  },
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

export function ClientGuide({ connectorLink }: { connectorLink: ReactNode }) {
  const [selected, setSelected] = useState<AiClientId>("claude-desktop");

  return (
    <>
      <div
        className={styles.clientToggle}
        role="group"
        aria-label="Which AI client are you connecting?"
      >
        {AI_CLIENTS.map((client) => (
          <button
            key={client.id}
            type="button"
            className={`${styles.clientToggleButton} ${
              selected === client.id ? styles.clientToggleActive : ""
            }`}
            aria-pressed={selected === client.id}
            onClick={() => setSelected(client.id)}
          >
            {client.label}
          </button>
        ))}
      </div>

      {selected === "claude-desktop" ? (
        <ClaudeDesktopSteps connectorLink={connectorLink} />
      ) : (
        <OtherClientSteps connectorLink={connectorLink} />
      )}

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
          The assistant reads and writes the same shared list the app does —
          edits are recorded under your user id, concurrent edits are detected
          rather than overwritten, and deletes (also available) ask you first.
          Every tool added to the server shows up in your assistant
          automatically, no reconnecting.
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
    </>
  );
}

/**
 * What linking actually does — the same trust chain regardless of client, so
 * both guides show it under their step 1.
 */
function LinkExplanation() {
  return (
    <p className={styles.explain}>
      <strong>What this step does:</strong> the link points your assistant at
      Looped In&apos;s MCP server. On first use the client registers itself with
      Looped In&apos;s sign-in service and asks <em>you</em> to sign in and
      consent — no keys to paste, nothing shared in advance. From then on every
      request the assistant makes carries your own session, checked by the API
      exactly as if you were using this site — so it sees what you can see, and
      nothing more.
    </p>
  );
}

function ClaudeDesktopSteps({ connectorLink }: { connectorLink: ReactNode }) {
  return (
    <>
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>1. Link the connector</h2>
        <p className={styles.muted}>
          This is your connection link — it&apos;s the whole configuration.
        </p>
        {connectorLink}
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
        </ol>
        <LinkExplanation />
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>2. Create a project with the assistant prompt</h2>
        <p className={styles.muted}>
          The connector tells Claude how to <em>reach</em> Looped In; a project
          prompt tells it how to <em>use</em> it — what the data means, how to
          search and count properly, and what it can&apos;t do. Chats inside the
          project get all of that for free.
        </p>
        <ol className={styles.steps}>
          <li>
            In Claude Desktop, open <em>Projects</em> and create a new project —
            call it <strong>Looped In</strong>.
          </li>
          <li>
            Open the project&apos;s <em>instructions</em> (&ldquo;Set project
            instructions&rdquo;) and paste the prompt below.
          </li>
          <li>
            Start your Looped In chats inside that project, with the connector
            enabled. That&apos;s it — ask it about your pipeline.
          </li>
        </ol>
        <CopyBlock value={ASSISTANT_PROMPT} label="Assistant prompt" />
      </section>
    </>
  );
}

function OtherClientSteps({ connectorLink }: { connectorLink: ReactNode }) {
  return (
    <>
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>1. Link the connector</h2>
        <p className={styles.muted}>
          Any MCP client that accepts a remote server URL works the same way —
          this link is the whole configuration.
        </p>
        {connectorLink}
        <ol className={styles.steps}>
          <li>
            Add the link wherever your client takes a remote MCP server —
            usually a <em>connectors</em> or <em>MCP servers</em> setting.
          </li>
          <li>
            Leave any OAuth client ID and secret <strong>empty</strong> — the
            client registers itself automatically.
          </li>
          <li>
            Sign in with your usual Looped In account when the browser window
            opens, and allow the connection.
          </li>
        </ol>
        <LinkExplanation />
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>2. Give it the assistant prompt</h2>
        <p className={styles.muted}>
          Wherever your client lets you set system instructions — a project, a
          workspace, a rules file — paste this prompt. It teaches the assistant
          what the tools return and how to use them well.
        </p>
        <CopyBlock value={ASSISTANT_PROMPT} label="Assistant prompt" />
      </section>
    </>
  );
}
