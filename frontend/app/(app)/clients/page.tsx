import type { Metadata } from "next";
import { Suspense } from "react";
import { callBackend } from "@/app/lib/backend";
import { ApiError } from "./api-error";
import { ClientManager } from "./client-manager";
import { PAGE_SIZE, type ClientListResponse } from "./types";
import styles from "./clients.module.css";

export const metadata: Metadata = {
  title: "Clients",
  description: "The shared outreach list — search, add, edit, and remove clients.",
};

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

export default function ClientsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <main className={styles.main}>
      <h1 className={styles.title}>Clients</h1>
      <p className={styles.intro}>
        The outreach list, shared by everyone signed in — not filed per user like
        your documents. Every change records who made it, and edits carry the
        version you loaded, so two people editing the same client is caught rather
        than silently resolved in favour of whoever saved last.
      </p>
      {/* auth() and the no-store fetch are request-dynamic, so the dynamic work — including
          reading searchParams — lives inside its own Suspense boundary. Cache Components is
          currently off (see next.config.ts); the boundary is kept so it can be re-enabled. */}
      <Suspense fallback={<p className={styles.muted}>Loading clients…</p>}>
        <ClientList searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

/**
 * The list is driven entirely by the URL.
 *
 * A client component cannot call `callBackend` (it is server-only), so the search box and pager
 * write `?search=&page=` and this server component re-reads them, re-fetches, and new props
 * arrive. That is the same data flow mutations use via `refresh()`, and it makes every list view
 * bookmarkable and shareable. It is the house pattern for list screens.
 */
async function ClientList({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const search = single(params.search);
  const industry = single(params.industry);
  const page = pageNumber(single(params.page));

  const query = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String((page - 1) * PAGE_SIZE),
  });
  if (search) {
    query.set("search", search);
  }
  if (industry) {
    query.set("industry", industry);
  }

  const result = await callBackend<ClientListResponse>(`/clients?${query}`);

  if (!result.ok) {
    return <ApiError status={result.status} error={result.error} />;
  }

  return (
    <ClientManager
      clients={result.data.clients}
      total={result.data.total}
      offset={result.data.offset}
      limit={result.data.limit}
      search={search}
      industry={industry}
    />
  );
}

/** A repeated query parameter arrives as an array; take the first and ignore the rest. */
function single(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

function pageNumber(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 1 ? parsed : 1;
}
