import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { currentUser } from "@clerk/nextjs/server";
import { Suspense, type ReactNode } from "react";
import { callBackend } from "@/app/lib/backend";
import type { ClientListResponse } from "../clients/types";
import type { DocumentListResponse } from "../documents/types";
import styles from "./dashboard.module.css";

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Your clients, your documents, and the AI clients connected to them.",
};

/**
 * The signed-in home screen.
 *
 * Every tile fetches on its own behind its own Suspense boundary, so one slow or unavailable
 * dependency delays only its own tile — the clients count comes from Neon and the documents
 * count from S3, and those fail independently by design (see `/db/ping` and
 * `/documents/ping`, which report them separately). A tile
 * that cannot answer says why in place rather than disappearing or taking the page down: the
 * whole point of the shell degrading gracefully is that an unconfigured backend still shows a
 * usable app.
 */
export default function DashboardPage() {
  return (
    <main className={styles.main}>
      <header className={styles.head}>
        <p className={styles.eyebrow}>Looped In</p>
        {/* currentUser() is request-dynamic, so the greeting streams while the rest renders. */}
        <Suspense fallback={<h1 className={styles.title}>Welcome</h1>}>
          <WelcomeHeading />
        </Suspense>
        <p className={styles.intro}>
          Your data and the assistants that reach it, on one account. Everything
          below is live — the counts come from the same authenticated API your
          AI clients call.
        </p>
      </header>

      <section className={styles.tiles} aria-label="Overview">
        <Suspense fallback={<Tile label="Clients" pending />}>
          <ClientsTile />
        </Suspense>
        <Suspense fallback={<Tile label="Documents" pending />}>
          <DocumentsTile />
        </Suspense>
        <Suspense fallback={<Tile label="Connect AI" pending />}>
          <ConnectTile />
        </Suspense>
      </section>
    </main>
  );
}

async function WelcomeHeading() {
  const user = await currentUser();
  const name = user?.firstName ?? user?.fullName ?? null;
  return <h1 className={styles.title}>Welcome{name ? `, ${name}` : ""}</h1>;
}

/* --- tiles ---------------------------------------------------------------------------- */

/**
 * One overview tile. `value` is the headline figure, `note` the line under it, and `problem`
 * replaces both when the dependency could not answer — the tile keeps its size either way so
 * the row does not reflow as the boundaries resolve.
 */
function Tile({
  label,
  value,
  note,
  href,
  cta,
  problem,
  pending = false,
}: {
  label: string;
  value?: ReactNode;
  note?: string;
  href?: string;
  cta?: string;
  problem?: string;
  pending?: boolean;
}) {
  return (
    <article className={`${styles.tile}${problem ? ` ${styles.tileProblem}` : ""}`}>
      <p className={styles.tileLabel}>{label}</p>
      {pending ? (
        <p className={styles.tileValue} aria-hidden="true">
          <span className={styles.skeleton} />
        </p>
      ) : problem ? (
        <p className={styles.tileProblemText}>{problem}</p>
      ) : (
        <>
          <p className={styles.tileValue}>{value}</p>
          {note && <p className={styles.tileNote}>{note}</p>}
        </>
      )}
      {href && cta && (
        <Link href={href} className={styles.tileLink}>
          {cta}
          <span aria-hidden="true"> →</span>
        </Link>
      )}
    </article>
  );
}

const count = new Intl.NumberFormat("en-AU");

async function ClientsTile() {
  // limit=1 because only `total` is wanted — the API returns the unpaged match count
  // alongside the page, so this costs one row instead of fifty.
  const result = await callBackend<ClientListResponse>("/clients?limit=1");

  if (!result.ok) {
    return <Tile label="Clients" problem={result.error} href="/clients" cta="Open clients" />;
  }

  const total = result.data.total;
  return (
    <Tile
      label="Clients"
      value={count.format(total)}
      note={total === 1 ? "client on the shared list" : "clients on the shared list"}
      href="/clients"
      cta="View all"
    />
  );
}

async function DocumentsTile() {
  const result = await callBackend<DocumentListResponse>("/documents");

  if (!result.ok) {
    return (
      <Tile label="Documents" problem={result.error} href="/documents" cta="Open documents" />
    );
  }

  const { documents, truncated } = result.data;
  return (
    <Tile
      label="Documents"
      // S3 listing is capped, so a truncated response is "at least this many", not a total.
      value={`${count.format(documents.length)}${truncated ? "+" : ""}`}
      note={documents.length === 1 ? "file held to your account" : "files held to your account"}
      href="/documents"
      cta="View all"
    />
  );
}

async function ConnectTile() {
  // MCP_URL is a runtime value (it is the gateway's address on a deployed stage), so this
  // has to resolve per request rather than being baked in at build time.
  await connection();
  const configured = Boolean(process.env.MCP_URL);

  return (
    <Tile
      label="Connect AI"
      value={
        <span className={styles.status}>
          <span
            className={`${styles.dot}${configured ? ` ${styles.dotReady}` : ""}`}
            aria-hidden="true"
          />
          {configured ? "Ready" : "Not set"}
        </span>
      }
      note={
        configured
          ? "Claude and any MCP client can connect"
          : "MCP_URL is unset, so there is no connector link to hand out"
      }
      href="/connect"
      cta={configured ? "Connect a client" : "Set up"}
    />
  );
}
