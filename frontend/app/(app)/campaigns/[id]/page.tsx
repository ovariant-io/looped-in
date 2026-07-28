import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { callBackend } from "@/app/lib/backend";
import { ApiError } from "@/app/(app)/clients/api-error";
import type { ClientListResponse } from "@/app/(app)/clients/types";
import { CampaignDetailView } from "./campaign-detail";
import type { CampaignDetail } from "../types";
import styles from "../campaigns.module.css";

export const metadata: Metadata = {
  title: "Campaign",
  description: "One campaign's drafts — review, edit, preview, and record outcomes.",
};

type Params = Promise<{ id: string }>;

export default function CampaignPage({ params }: { params: Params }) {
  return (
    <main className={styles.main}>
      <Link href="/campaigns" className={styles.backLink}>
        ← All campaigns
      </Link>
      <Suspense fallback={<p className={styles.muted}>Loading campaign…</p>}>
        <CampaignLoader params={params} />
      </Suspense>
    </main>
  );
}

/**
 * Two independent reads, in parallel. Only the campaign is load-bearing; the client list feeds
 * the add-message picker, so its failure degrades to an empty picker plus a note — the
 * `sideLoadFailed` shape from the client detail page.
 *
 * The picker fetch asks for `limit=200`, which is the API's MaxPageSize — past 200 clients this
 * silently truncates. A recorded deferral (the seeded list is already at ~191): the fix is a
 * searchable picker backed by `?search=`, not a bigger page.
 */
async function CampaignLoader({ params }: { params: Params }) {
  const { id } = await params;
  const encoded = encodeURIComponent(id);

  const [campaign, clients] = await Promise.all([
    callBackend<CampaignDetail>(`/campaigns/${encoded}`),
    callBackend<ClientListResponse>("/clients?limit=200"),
  ]);

  if (!campaign.ok) {
    return (
      <ApiError
        status={campaign.status}
        error={campaign.error}
        what="this campaign"
        backHref="/campaigns"
        backLabel="Back to all campaigns"
      />
    );
  }

  return (
    <CampaignDetailView
      campaign={campaign.data}
      clientOptions={clients.ok ? clients.data.clients : []}
      pickerLoadFailed={!clients.ok}
    />
  );
}
