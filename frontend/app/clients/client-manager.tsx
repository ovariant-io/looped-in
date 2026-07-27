"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { createClient, deleteClient, updateClientFromRow } from "./actions";
import type { ClientSummary } from "./types";
import styles from "./clients.module.css";

/**
 * The interactive half of the clients page.
 *
 * Holds **no copy** of the client list: it renders straight from props, and the mutating Server
 * Actions call `refresh()`, so the server re-renders and new props arrive. A local `useState`
 * mirror would go stale on every edit and delete — and on this screen it would go stale for a
 * second reason too, because someone else can be editing the same rows.
 *
 * List state (search, page) lives in the URL rather than in state, because a client component
 * cannot call the backend: it navigates, the server component re-reads `searchParams` and
 * re-fetches. Local state here covers only what the server does not know — which row is open for
 * editing, and the last failure or notice.
 */
export function ClientManager({
  clients,
  total,
  offset,
  limit,
  search,
  industry,
}: {
  clients: ClientSummary[];
  total: number;
  offset: number;
  limit: number;
  search: string;
  industry: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const page = Math.floor(offset / limit) + 1;
  const firstRow = clients.length === 0 ? 0 : offset + 1;
  const lastRow = offset + clients.length;
  const filtered = search !== "" || industry !== "";

  function navigate(next: { search?: string; industry?: string; page?: number }) {
    const query = new URLSearchParams();
    const nextSearch = next.search ?? search;
    const nextIndustry = next.industry ?? industry;
    const nextPage = next.page ?? 1;

    if (nextSearch) {
      query.set("search", nextSearch);
    }
    if (nextIndustry) {
      query.set("industry", nextIndustry);
    }
    if (nextPage > 1) {
      query.set("page", String(nextPage));
    }

    const qs = query.toString();
    router.replace(qs ? `/clients?${qs}` : "/clients", { scroll: false });
  }

  function onSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    // Back to page 1: staying on page 4 of the old result set would usually show nothing.
    navigate({ search: String(data.get("search") ?? "").trim(), page: 1 });
  }

  function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);

    startTransition(async () => {
      setFailure(null);
      setNotice(null);

      const result = await createClient({
        name: value(data, "name") ?? "",
        industry: value(data, "industry"),
        location: value(data, "location"),
        notes: value(data, "notes"),
      });

      if (!result.ok) {
        setFailure({ status: result.status, message: result.error });
        return;
      }

      form.reset();
      setCreating(false);
      // A duplicate name is a warning, not a rejection — the row was created either way.
      setNotice(result.data.warning ?? `Added “${result.data.client.name}”.`);
    });
  }

  function onSaveRow(event: FormEvent<HTMLFormElement>, client: ClientSummary) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);

    startTransition(async () => {
      setFailure(null);
      setNotice(null);

      const result = await updateClientFromRow(
        client.id,
        {
          name: value(data, "name") ?? "",
          industry: value(data, "industry"),
          location: value(data, "location"),
        },
        // The version this row was RENDERED with, not a fresh one — that is what makes a
        // simultaneous edit by someone else a 409 instead of a silent overwrite.
        client.version,
      );

      if (!result.ok) {
        setFailure({ status: result.status, message: result.error });
        return;
      }

      setEditingId(null);
      setNotice(`Saved “${result.data.name}”.`);
    });
  }

  function onDelete(client: ClientSummary) {
    // Naming the contact count is the guard: DELETE cascades and takes no version, so this
    // confirmation is the only thing standing between a click and permanent loss.
    const contacts =
      client.contactCount === 0
        ? ""
        : ` and its ${client.contactCount} contact${client.contactCount === 1 ? "" : "s"}`;

    if (!window.confirm(`Delete “${client.name}”${contacts}? This cannot be undone.`)) {
      return;
    }

    startTransition(async () => {
      setFailure(null);
      setNotice(null);

      const result = await deleteClient(client.id);
      if (!result.ok) {
        setFailure({ status: result.status, message: result.error });
        return;
      }

      setNotice(`Deleted “${client.name}”.`);
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
            placeholder="Search name, industry, location, or a contact…"
            aria-label="Search clients"
          />
          <button type="submit" className={styles.button} disabled={isPending}>
            Search
          </button>
          {filtered ? (
            <button
              type="button"
              className={styles.button}
              disabled={isPending}
              onClick={() => navigate({ search: "", industry: "", page: 1 })}
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
          {creating ? "Cancel" : "Add client"}
        </button>
      </div>

      {creating ? (
        <form className={styles.card} onSubmit={onCreate}>
          <p className={styles.cardTitle}>New client</p>
          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span className={styles.label}>Name (required)</span>
              <input className={styles.input} name="name" required maxLength={200} autoFocus />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Industry</span>
              <input className={styles.input} name="industry" maxLength={100} />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Location</span>
              <input className={styles.input} name="location" maxLength={100} />
            </label>
            <label className={`${styles.field} ${styles.wide}`}>
              <span className={styles.label}>Notes</span>
              <textarea className={styles.textarea} name="notes" maxLength={4000} />
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
          </div>
        </form>
      ) : null}

      {failure ? <FailureBanner failure={failure} onReload={() => router.refresh()} /> : null}

      {notice ? (
        <section className={`${styles.card} ${styles.notice}`}>
          <p className={styles.muted}>{notice}</p>
        </section>
      ) : null}

      {clients.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.muted}>
            {filtered
              ? `No clients match ${search ? `“${search}”` : "that filter"}.`
              : page > 1
                ? "There is nothing on this page."
                : "No clients yet."}
          </p>
          {filtered ? (
            <button
              type="button"
              className={styles.button}
              onClick={() => navigate({ search: "", industry: "", page: 1 })}
            >
              Show all clients
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
                <th scope="col">Client</th>
                <th scope="col">Industry</th>
                <th scope="col">Location</th>
                <th scope="col">Contacts</th>
                <th scope="col">Updated</th>
                <th scope="col">
                  <span className={styles.srOnly}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {clients.map((client) =>
                editingId === client.id ? (
                  <tr key={client.id} className={styles.editRow}>
                    <td colSpan={6}>
                      <form onSubmit={(event) => onSaveRow(event, client)}>
                        <div className={styles.editGrid}>
                          <label className={styles.field}>
                            <span className={styles.label}>Name</span>
                            <input
                              className={styles.input}
                              name="name"
                              defaultValue={client.name}
                              required
                              maxLength={200}
                              autoFocus
                            />
                          </label>
                          <label className={styles.field}>
                            <span className={styles.label}>Industry</span>
                            <input
                              className={styles.input}
                              name="industry"
                              defaultValue={client.industry ?? ""}
                              maxLength={100}
                            />
                          </label>
                          <label className={styles.field}>
                            <span className={styles.label}>Location</span>
                            <input
                              className={styles.input}
                              name="location"
                              defaultValue={client.location ?? ""}
                              maxLength={100}
                            />
                          </label>
                        </div>
                        <div className={styles.formActions}>
                          <button
                            type="submit"
                            className={`${styles.primary} ${styles.small}`}
                            disabled={isPending}
                          >
                            {isPending ? "Saving…" : "Save"}
                          </button>
                          <button
                            type="button"
                            className={`${styles.button} ${styles.small}`}
                            disabled={isPending}
                            onClick={() => setEditingId(null)}
                          >
                            Cancel
                          </button>
                          <span className={styles.hint}>
                            Notes are edited on the client&apos;s own page.
                          </span>
                        </div>
                      </form>
                    </td>
                  </tr>
                ) : (
                  <tr key={client.id}>
                    <td className={styles.nameCell}>
                      <Link href={`/clients/${client.id}`} className={styles.nameLink}>
                        {client.name}
                      </Link>
                    </td>
                    <td>{client.industry ?? <span className={styles.count}>—</span>}</td>
                    <td>{client.location ?? <span className={styles.count}>—</span>}</td>
                    <td className={styles.count}>{client.contactCount}</td>
                    {/* Sliced, not parsed: a Date here would format against the server's
                        timezone during SSR and the browser's after hydration. */}
                    <td className={styles.count}>{client.updatedAt.slice(0, 10)}</td>
                    <td>
                      <div className={styles.rowActions}>
                        <button
                          type="button"
                          className={`${styles.button} ${styles.small}`}
                          disabled={isPending}
                          onClick={() => {
                            setEditingId(client.id);
                            setFailure(null);
                            setNotice(null);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className={`${styles.button} ${styles.small} ${styles.danger}`}
                          disabled={isPending}
                          onClick={() => onDelete(client)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className={styles.pager}>
        <span className={styles.range}>
          {total === 0
            ? "0 clients"
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

export type Failure = { status: number; message: string };

/**
 * A stale-version 409 gets its own treatment rather than a generic failure banner: it is not an
 * error the user made, it is the expected outcome of two people editing one shared row, and the
 * only useful next step is to reload and look at what changed.
 */
export function FailureBanner({
  failure,
  onReload,
}: {
  failure: Failure;
  onReload: () => void;
}) {
  const conflict = failure.status === 409;

  return (
    <section className={`${styles.card} ${conflict ? styles.conflict : styles.error}`}>
      <p className={styles.cardTitle}>
        {conflict ? "🔄 Someone else got there first" : "❌ That didn't work"}
      </p>
      <p className={styles.muted}>{failure.message}</p>
      {conflict ? (
        <div className={styles.formActions}>
          <button type="button" className={styles.button} onClick={onReload}>
            Reload
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** Trimmed form value, with empty meaning "clear this field" — PATCH replaces, it never merges. */
function value(data: FormData, key: string): string | null {
  const text = String(data.get(key) ?? "").trim();
  return text === "" ? null : text;
}
