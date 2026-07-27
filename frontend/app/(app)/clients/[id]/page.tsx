import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { callBackend } from "@/app/lib/backend";
import { ApiError } from "../api-error";
import { ClientDetailView } from "./client-detail";
import type { ClientDetail } from "../types";
import styles from "../clients.module.css";

export const metadata: Metadata = {
  title: "Client",
  description: "One client, its details, and its contacts.",
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
  const result = await callBackend<ClientDetail>(`/clients/${encodeURIComponent(id)}`);

  if (!result.ok) {
    return <ApiError status={result.status} error={result.error} what="this client" />;
  }

  return <ClientDetailView client={result.data} />;
}
