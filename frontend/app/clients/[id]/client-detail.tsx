"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import {
  addContact,
  deleteClient,
  deleteContact,
  updateClient,
  updateContact,
} from "../actions";
import { FailureBanner } from "../client-manager";
import { IMPORT_SENTINEL, type ClientDetail, type ContactSummary } from "../types";
import styles from "../clients.module.css";

/**
 * One client and its contacts.
 *
 * This is where a *full* edit happens: unlike a list row, everything mutable is on screen, so a
 * PATCH can replace every field in one request without having to read anything first.
 *
 * Like the list, it renders straight from props — mutations go through Server Actions that call
 * `refresh()` and new props arrive.
 */
export function ClientDetailView({ client }: { client: ClientDetail }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [failure, setFailure] = useState<{ status: number; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [addingContact, setAddingContact] = useState(false);
  const [editingContactId, setEditingContactId] = useState<string | null>(null);

  function reset() {
    setFailure(null);
    setNotice(null);
  }

  function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);

    startTransition(async () => {
      reset();
      const result = await updateClient(
        client.id,
        {
          name: value(data, "name") ?? "",
          industry: value(data, "industry"),
          location: value(data, "location"),
          notes: value(data, "notes"),
        },
        client.version,
      );

      if (!result.ok) {
        setFailure({ status: result.status, message: result.error });
        return;
      }

      setEditing(false);
      setNotice("Saved.");
    });
  }

  function onDeleteClient() {
    const contacts =
      client.contacts.length === 0
        ? ""
        : ` and its ${client.contacts.length} contact${client.contacts.length === 1 ? "" : "s"}`;

    if (!window.confirm(`Delete “${client.name}”${contacts}? This cannot be undone.`)) {
      return;
    }

    startTransition(async () => {
      reset();
      const result = await deleteClient(client.id);
      if (!result.ok) {
        setFailure({ status: result.status, message: result.error });
        return;
      }

      // This page no longer has anything to show.
      router.push("/clients");
    });
  }

  function onAddContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);

    startTransition(async () => {
      reset();
      const result = await addContact(client.id, {
        fullName: value(data, "fullName"),
        email: value(data, "email"),
        roleTitle: value(data, "roleTitle"),
        notes: value(data, "notes"),
      });

      if (!result.ok) {
        setFailure({ status: result.status, message: result.error });
        return;
      }

      form.reset();
      setAddingContact(false);
      setNotice("Contact added.");
    });
  }

  function onSaveContact(event: FormEvent<HTMLFormElement>, contact: ContactSummary) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);

    startTransition(async () => {
      reset();
      const result = await updateContact(
        client.id,
        contact.id,
        {
          fullName: value(data, "fullName"),
          email: value(data, "email"),
          roleTitle: value(data, "roleTitle"),
          notes: value(data, "notes"),
        },
        contact.version,
      );

      if (!result.ok) {
        setFailure({ status: result.status, message: result.error });
        return;
      }

      setEditingContactId(null);
      setNotice("Contact saved.");
    });
  }

  function onDeleteContact(contact: ContactSummary) {
    const label = contact.fullName ?? contact.email ?? "this contact";
    if (!window.confirm(`Remove “${label}” from ${client.name}? This cannot be undone.`)) {
      return;
    }

    startTransition(async () => {
      reset();
      const result = await deleteContact(client.id, contact.id);
      if (!result.ok) {
        setFailure({ status: result.status, message: result.error });
        return;
      }

      setNotice("Contact removed.");
    });
  }

  return (
    <div className={styles.manager}>
      <h1 className={styles.title}>{client.name}</h1>

      <div className={styles.provenance}>
        <span>{describeActor("Added", client.createdBy, client.createdAt)}</span>
        <span>{describeActor("Updated", client.updatedBy, client.updatedAt)}</span>
        <span>v{client.version}</span>
      </div>

      {failure ? <FailureBanner failure={failure} onReload={() => router.refresh()} /> : null}

      {notice ? (
        <section className={`${styles.card} ${styles.notice}`}>
          <p className={styles.muted}>{notice}</p>
        </section>
      ) : null}

      {editing ? (
        <form className={styles.card} onSubmit={onSave}>
          <p className={styles.cardTitle}>Edit client</p>
          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span className={styles.label}>Name (required)</span>
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
            <label className={`${styles.field} ${styles.wide}`}>
              <span className={styles.label}>Notes</span>
              <textarea
                className={styles.textarea}
                name="notes"
                defaultValue={client.notes ?? ""}
                maxLength={4000}
              />
            </label>
          </div>
          <div className={styles.formActions}>
            <button type="submit" className={styles.primary} disabled={isPending}>
              {isPending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className={styles.button}
              disabled={isPending}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            {/* Clearing a field is how you clear it: PATCH replaces every field it is sent. */}
            <span className={styles.hint}>An emptied field is cleared, not left alone.</span>
          </div>
        </form>
      ) : (
        <section className={styles.card}>
          <div className={styles.formGrid}>
            <Detail label="Industry" text={client.industry} />
            <Detail label="Location" text={client.location} />
          </div>
          {client.notes ? (
            <div className={styles.field}>
              <span className={styles.label}>Notes</span>
              <p className={styles.contactNote}>{client.notes}</p>
            </div>
          ) : null}
          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.button}
              disabled={isPending}
              onClick={() => {
                setEditing(true);
                reset();
              }}
            >
              Edit client
            </button>
            <button
              type="button"
              className={`${styles.button} ${styles.danger}`}
              disabled={isPending}
              onClick={onDeleteClient}
            >
              Delete client
            </button>
          </div>
        </section>
      )}

      <div className={styles.toolbar}>
        <span className={styles.meta}>
          {client.contacts.length === 0
            ? "No contacts"
            : `${client.contacts.length} contact${client.contacts.length === 1 ? "" : "s"}`}
        </span>
        <button
          type="button"
          className={`${styles.button} ${styles.small}`}
          disabled={isPending}
          onClick={() => {
            setAddingContact((open) => !open);
            reset();
          }}
        >
          {addingContact ? "Cancel" : "Add contact"}
        </button>
      </div>

      {addingContact ? (
        <form className={styles.card} onSubmit={onAddContact}>
          <p className={styles.cardTitle}>New contact</p>
          <ContactFields />
          <div className={styles.formActions}>
            <button type="submit" className={styles.primary} disabled={isPending}>
              {isPending ? "Saving…" : "Add"}
            </button>
            <span className={styles.hint}>A name or an email address is required.</span>
          </div>
        </form>
      ) : null}

      {client.contacts.length > 0 ? (
        <ul className={styles.contactList}>
          {client.contacts.map((contact) =>
            editingContactId === contact.id ? (
              <li key={contact.id} className={styles.contact}>
                <form
                  className={styles.fullWidth}
                  onSubmit={(event) => onSaveContact(event, contact)}
                >
                  <ContactFields contact={contact} />
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
                      onClick={() => setEditingContactId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </li>
            ) : (
              <li key={contact.id} className={styles.contact}>
                <div className={styles.contactBody}>
                  <span className={styles.contactName}>
                    {contact.fullName ?? <em>No name recorded</em>}
                    {contact.roleTitle ? (
                      <span className={styles.count}> · {contact.roleTitle}</span>
                    ) : null}
                  </span>
                  {contact.email ? (
                    <a className={styles.contactEmail} href={`mailto:${contact.email}`}>
                      {contact.email}
                    </a>
                  ) : (
                    <span className={styles.count}>No email address</span>
                  )}
                  {contact.notes ? (
                    <span className={styles.contactNote}>{contact.notes}</span>
                  ) : null}
                </div>
                <div className={styles.rowActions}>
                  <button
                    type="button"
                    className={`${styles.button} ${styles.small}`}
                    disabled={isPending}
                    onClick={() => {
                      setEditingContactId(contact.id);
                      reset();
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className={`${styles.button} ${styles.small} ${styles.danger}`}
                    disabled={isPending}
                    onClick={() => onDeleteContact(contact)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      ) : null}
    </div>
  );
}

function ContactFields({ contact }: { contact?: ContactSummary }) {
  return (
    <div className={styles.formGrid}>
      <label className={styles.field}>
        <span className={styles.label}>Name</span>
        <input
          className={styles.input}
          name="fullName"
          defaultValue={contact?.fullName ?? ""}
          maxLength={200}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Email</span>
        <input
          className={styles.input}
          name="email"
          type="email"
          defaultValue={contact?.email ?? ""}
          maxLength={320}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Role</span>
        <input
          className={styles.input}
          name="roleTitle"
          defaultValue={contact?.roleTitle ?? ""}
          maxLength={200}
        />
      </label>
      <label className={`${styles.field} ${styles.wide}`}>
        <span className={styles.label}>Notes</span>
        <textarea
          className={styles.textarea}
          name="notes"
          defaultValue={contact?.notes ?? ""}
          maxLength={4000}
        />
      </label>
    </div>
  );
}

function Detail({ label, text }: { label: string; text: string | null }) {
  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      <span>{text ?? <span className={styles.count}>Not recorded</span>}</span>
    </div>
  );
}

/**
 * Renders `created_by` / `updated_by`, which hold the Clerk subject of whoever wrote the row —
 * except on seeded rows, which carry the import sentinel forever. Showing that as a raw
 * `import:…` string would be noise; naming it is the point of having the sentinel.
 */
function describeActor(verb: string, actor: string, at: string): string {
  const when = at.slice(0, 10);
  return actor === IMPORT_SENTINEL
    ? `${verb} ${when} · from the outreach spreadsheet`
    : `${verb} ${when} · ${actor}`;
}

/** Trimmed form value; empty means "clear this field", because PATCH replaces rather than merges. */
function value(data: FormData, key: string): string | null {
  const text = String(data.get(key) ?? "").trim();
  return text === "" ? null : text;
}
