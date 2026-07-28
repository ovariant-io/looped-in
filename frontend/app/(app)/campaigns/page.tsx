import type { Metadata } from "next";
import { Suspense } from "react";
import { callBackend } from "@/app/lib/backend";
import { ApiError } from "@/app/(app)/clients/api-error";
import { CampaignManager } from "./campaign-manager";
import { PAGE_SIZE, type CampaignListResponse } from "./types";
import styles from "./campaigns.module.css";

export const metadata: Metadata = {
  title: "Campaigns",
  description: "EDM drafting — one personalized email per client, reviewed before it is sent.",
};

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

export default function CampaignsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  return (
    <main className={styles.main}>
      <h1 className={styles.title}>Campaigns</h1>
      {/* Same shape as the clients page: the dynamic work — auth() inside callBackend, and
          reading searchParams — lives inside its own Suspense boundary. */}
      <Suspense fallback={<p className={styles.muted}>Loading campaigns…</p>}>
        <CampaignList searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

/**
 * URL-driven like every list screen (see clients/page.tsx for the rationale): the search box and
 * pager write `?search=&page=`, this server component re-reads them and re-fetches. There is no
 * status filter — a campaign has no status; its progress is the per-row state counts.
 */
async function CampaignList({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const search = single(params.search);
  const page = pageNumber(single(params.page));

  const query = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String((page - 1) * PAGE_SIZE),
  });
  if (search) {
    query.set("search", search);
  }

  const result = await callBackend<CampaignListResponse>(`/campaigns?${query}`);

  if (!result.ok) {
    return <ApiError status={result.status} error={result.error} what="campaigns" />;
  }

  return (
    <CampaignManager
      campaigns={result.data.campaigns}
      total={result.data.total}
      offset={result.data.offset}
      limit={result.data.limit}
      search={search}
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
