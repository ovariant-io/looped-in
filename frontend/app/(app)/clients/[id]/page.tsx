import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { callBackend } from "@/app/lib/backend";
import { ApiError } from "../api-error";
import { ClientDetailView } from "./client-detail";
import type { ClientDetail, InteractionSummary, StatusHistoryEntry } from "../types";
import styles from "../clients.module.css";

export const metadata: Metadata = {
  title: "Client",
  description: "One client — its details, pipeline status, contacts, and interaction log.",
};

type Params = Promise<{ id: string }>;

export default function ClientPage({ params }: { params: Params }) {
  return (
    <main className={styles.main}>
      <Link href="/clients" className={styles.backLink}>
        ← All clients
      </Link>
      {/* Same shape as the list page: the request-dynamic work (auth() and the no-store fetch,
          plus awaiting params) sits inside its own Suspense boundary. */}
      <Suspense fallback={<p className={styles.muted}>Loading client…</p>}>
        <ClientLoader params={params} />
      </Suspense>
    </main>
  );
}

async function ClientLoader({ params }: { params: Params }) {
  const { id } = await params;
  const encoded = encodeURIComponent(id);

  // Three independent reads, in parallel. Only the client itself is load-bearing: a failure on
  // the two side lists degrades to an empty list plus a note, because "the log didn't load" is
  // no reason to hide the client.
  const [client, interactions, history] = await Promise.all([
    callBackend<ClientDetail>(`/clients/${encoded}`),
    callBackend<InteractionSummary[]>(`/clients/${encoded}/interactions`),
    callBackend<StatusHistoryEntry[]>(`/clients/${encoded}/status-history`),
  ]);

  if (!client.ok) {
    return <ApiError status={client.status} error={client.error} what="this client" />;
  }

  return (
    <ClientDetailView
      client={client.data}
      interactions={interactions.ok ? interactions.data : []}
      history={history.ok ? history.data : []}
      sideLoadFailed={!interactions.ok || !history.ok}
    />
  );
}
