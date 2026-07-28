"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { FailureBanner, type Failure } from "@/app/(app)/clients/client-manager";
import { createCampaign } from "./actions";
import {
  MESSAGE_STATE_LABELS,
  type CampaignMessageState,
  type CampaignSummary,
} from "./types";
import styles from "./campaigns.module.css";

/**
 * The interactive half of the campaigns list, following clients/client-manager.tsx: no copy of
 * the list (props + `refresh()` are the data flow), list state in the URL, local state only for
 * the create form and the last failure/notice. The list stays thin on purpose — editing and
 * deleting a campaign live on its own page, where the messages give those actions their context.
 */
export function CampaignManager({
  campaigns,
  total,
  offset,
  limit,
  search,
}: {
  campaigns: CampaignSummary[];
  total: number;
  offset: number;
  limit: number;
  search: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const page = Math.floor(offset / limit) + 1;
  const firstRow = campaigns.length === 0 ? 0 : offset + 1;
  const lastRow = offset + campaigns.length;
  const filtered = search !== "";

  function navigate(next: { search?: string; page?: number }) {
    const query = new URLSearchParams();
    const nextSearch = next.search ?? search;
    const nextPage = next.page ?? 1;

    if (nextSearch) {
      query.set("search", nextSearch);
    }
    if (nextPage > 1) {
      query.set("page", String(nextPage));
    }

    const qs = query.toString();
    router.replace(qs ? `/campaigns?${qs}` : "/campaigns", { scroll: false });
  }

  function onSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    navigate({ search: String(data.get("search") ?? "").trim(), page: 1 });
  }

  function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);

    startTransition(async () => {
      setFailure(null);
      setNotice(null);

      const result = await createCampaign({
        name: String(data.get("name") ?? "").trim(),
        brief: value(data, "brief"),
      });

      if (!result.ok) {
        setFailure({ status: result.status, message: result.error });
        return;
      }

      form.reset();
      setCreating(false);
      setNotice(`Created “${result.data.name}”.`);
    });
  }

  return (
    <div className={styles.manager}>
      <div className={styles.toolbar}>
        <form className={styles.searchForm} onSubmit={onSearch} role="search">
          <input
            className={styles.input}
            type="search"
            name="search"
            defaultValue={search}
            placeholder="Search campaign names…"
            aria-label="Search campaigns"
          />
          <button type="submit" className={styles.button} disabled={isPending}>
            Search
          </button>
          {filtered ? (
            <button
              type="button"
              className={styles.button}
              disabled={isPending}
              onClick={() => navigate({ search: "", page: 1 })}
            >
              Clear
            </button>
          ) : null}
        </form>

        <button
          type="button"
          className={styles.primary}
          disabled={isPending}
          onClick={() => {
            setCreating((open) => !open);
            setNotice(null);
          }}
        >
          {creating ? "Cancel" : "New campaign"}
        </button>
      </div>

      {creating ? (
        <form className={styles.card} onSubmit={onCreate}>
          <p className={styles.cardTitle}>New campaign</p>
          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span className={styles.label}>Name (required)</span>
              <input className={styles.input} name="name" required maxLength={200} autoFocus />
            </label>
            <label className={`${styles.field} ${styles.wide}`}>
              <span className={styles.label}>Brief</span>
              <textarea
                className={styles.textarea}
                name="brief"
                maxLength={4000}
                placeholder="Who this campaign is for, the offer or message, and the voice to write in."
              />
            </label>
          </div>
          <div className={styles.formActions}>
            <button type="submit" className={styles.primary} disabled={isPending}>
              {isPending ? "Saving…" : "Create"}
            </button>
            <button
              type="button"
              className={styles.button}
              disabled={isPending}
              onClick={() => setCreating(false)}
            >
              Cancel
            </button>
            <span className={styles.hint}>
              The brief doubles as the drafting instruction for a connected assistant.
            </span>
          </div>
        </form>
      ) : null}

      {failure ? <FailureBanner failure={failure} onReload={() => router.refresh()} /> : null}

      {notice ? (
        <section className={`${styles.card} ${styles.notice}`}>
          <p className={styles.muted}>{notice}</p>
        </section>
      ) : null}

      {campaigns.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.muted}>
            {filtered
              ? `No campaigns match “${search}”.`
              : page > 1
                ? "There is nothing on this page."
                : "No campaigns yet."}
          </p>
          {filtered ? (
            <button
              type="button"
              className={styles.button}
              onClick={() => navigate({ search: "", page: 1 })}
            >
              Show all campaigns
            </button>
          ) : null}
          {!filtered && page > 1 ? (
            <button type="button" className={styles.button} onClick={() => navigate({ page: 1 })}>
              Back to the first page
            </button>
          ) : null}
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Campaign</th>
                <th scope="col">Messages</th>
                <th scope="col">Progress</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((campaign) => (
                <tr key={campaign.id}>
                  <td className={styles.nameCell}>
                    <Link href={`/campaigns/${campaign.id}`} className={styles.nameLink}>
                      {campaign.name}
                    </Link>
                  </td>
                  <td className={styles.count}>{campaign.messageCount}</td>
                  <td>
                    <StateChips campaign={campaign} />
                  </td>
                  {/* Sliced, not parsed — same SSR/hydration timezone reasoning as clients. */}
                  <td className={styles.count}>{campaign.updatedAt.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className={styles.pager}>
        <span className={styles.range}>
          {total === 0
            ? "0 campaigns"
            : `${firstRow}–${lastRow} of ${total}${filtered ? " matching" : ""}`}
        </span>
        <div className={styles.pagerButtons}>
          <button
            type="button"
            className={styles.button}
            disabled={offset === 0 || isPending}
            onClick={() => navigate({ page: page - 1 })}
          >
            Previous
          </button>
          <button
            type="button"
            className={styles.button}
            disabled={lastRow >= total || isPending}
            onClick={() => navigate({ page: page + 1 })}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The per-state counts as chips, zero-count states omitted — four "0"s per row is noise, and an
 * all-zero campaign reads better as its message count's plain 0.
 */
function StateChips({ campaign }: { campaign: CampaignSummary }) {
  const counts: [CampaignMessageState, number][] = [
    ["drafted", campaign.draftedCount],
    ["approved", campaign.approvedCount],
    ["sent", campaign.sentCount],
    ["skipped", campaign.skippedCount],
  ];
  const present = counts.filter(([, count]) => count > 0);

  if (present.length === 0) {
    return <span className={styles.count}>—</span>;
  }

  return (
    <div className={styles.chips}>
      {present.map(([state, count]) => (
        <span key={state} className={stateBadgeClass(state)}>
          {MESSAGE_STATE_LABELS[state]} {count}
        </span>
      ))}
    </div>
  );
}

/**
 * State → badge class, shared with the detail page — same grouping logic as the client status
 * badges: approved takes the theme-derived accent, sent the non-themeable correctness green,
 * drafted and skipped rest neutral.
 */
export function stateBadgeClass(state: CampaignMessageState): string {
  switch (state) {
    case "approved":
      return `${styles.badge} ${styles.badgeApproved}`;
    case "sent":
      return `${styles.badge} ${styles.badgeSent}`;
    default: // drafted, skipped — the resting states
      return styles.badge;
  }
}

/** Trimmed form value, with empty meaning "clear this field" — PATCH replaces, it never merges. */
function value(data: FormData, key: string): string | null {
  const text = String(data.get(key) ?? "").trim();
  return text === "" ? null : text;
}
