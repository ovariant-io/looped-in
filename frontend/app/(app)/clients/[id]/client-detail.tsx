"use client";

import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import {
  addContact,
  addInteraction,
  changeClientStatus,
  deleteClient,
  deleteContact,
  deleteInteraction,
  updateClient,
  updateContact,
  updateInteraction,
} from "../actions";
import { badgeClass, FailureBanner, type EditTarget } from "../client-manager";
import {
  CLIENT_STATUSES,
  IMPORT_SENTINEL,
  INTERACTION_KINDS,
  KIND_LABELS,
  STATUS_LABELS,
  type ClientDetail,
  type ClientStatus,
  type ContactSummary,
  type InteractionFields,
  type InteractionKind,
  type InteractionSummary,
  type StatusHistoryEntry,
} from "../types";
import styles from "../clients.module.css";

/**
 * One client and its contacts.
 *
 * This is where a *full* edit happens: unlike a list row, everything mutable is on screen, so a
 * PATCH can replace every field in one request without having to read anything first.
 *
 * Like the list, it renders straight from props — mutations go through Server Actions that call
 * `refresh()` and new props arrive.
 *
 * **An open editor holds the version its form was populated from**, not `client.version` /
 * `contact.version` read at save time. The inputs are uncontrolled, so their values freeze when
 * the form mounts while props keep arriving — every contact mutation on this page calls
 * `refresh()`, and the contact controls stay live underneath an open client form. Reading the
 * version off current props would let someone else's edit be silently overwritten by values typed
 * against the older row; the snapshot is what makes that a 409.
 */
export function ClientDetailView({
  client,
  interactions,
  history,
  sideLoadFailed,
}: {
  client: ClientDetail;
  interactions: InteractionSummary[];
  history: StatusHistoryEntry[];
  sideLoadFailed: boolean;
}) {
  const router = useRouter();
  // For rendering the caller's own Clerk id as "you" in owner and logged-by lines. The id is
  // display-sugar only — every write derives the actor from the token server-side.
  const { user } = useUser();
  const myId = user?.id ?? null;
  const [isPending, startTransition] = useTransition();
  const [failure, setFailure] = useState<{ status: number; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [addingContact, setAddingContact] = useState(false);
  const [editingContact, setEditingContact] = useState<EditTarget | null>(null);
  // Controlled (unlike the frozen edit forms) so the lost-reason input can appear the moment
  // "Lost" is selected, before anything is submitted.
  const [pendingStatus, setPendingStatus] = useState<ClientStatus>(client.status);
  const [addingInteraction, setAddingInteraction] = useState(false);
  const [editingInteraction, setEditingInteraction] = useState<EditTarget | null>(null);

  function reset() {
    setFailure(null);
    setNotice(null);
  }

  function onSave(event: FormEvent<HTMLFormElement>, expectedVersion: number) {
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
          source: value(data, "source"),
          // Not on this form — owner moves through the pipeline panel's buttons. Passed through
          // from props so the full-replacement PATCH doesn't unassign on every save; if it
          // changed underneath, the version check below turns that into a 409, not a wipe.
          owner: client.owner,
        },
        // Captured when the editor opened, not read off props here — see the note above.
        expectedVersion,
      );

      if (!result.ok) {
        setFailure({ status: result.status, message: result.error });
        return;
      }

      setEditing(null);
      setNotice("Saved.");
    });
  }

  function onChangeStatus(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    // Read before the transition: the reason input unmounts if the select moves off "lost".
    const lostReason = pendingStatus === "lost" ? value(data, "lostReason") : null;

    startTransition(async () => {
      reset();
      // `client.version` from live props is honest HERE, unlike in the frozen edit forms: this
      // panel renders live, so the version always matches the status the user is looking at. A
      // concurrent transition still lands as a 409 with the reload affordance.
      const result = await changeClientStatus(client.id, pendingStatus, lostReason, client.version);

      if (!result.ok) {
        setFailure({ status: result.status, message: result.error });
        return;
      }

      setNotice(`Status changed to ${STATUS_LABELS[result.data.status]}.`);
    });
  }

  function onSetOwner(nextOwner: string | null) {
    startTransition(async () => {
      reset();
      // PATCH is the only carrier of owner, and it replaces every field — so the rest come from
      // live props unchanged. Live version is honest for the same reason as onChangeStatus.
      const result = await updateClient(
        client.id,
        {
          name: client.name,
          industry: client.industry,
          location: client.location,
          notes: client.notes,
          source: client.source,
          owner: nextOwner,
        },
        client.version,
      );

      if (!result.ok) {
        setFailure({ status: result.status, message: result.error });
        return;
      }

      setNotice(nextOwner === null ? "Owner cleared." : "Assigned to you.");
    });
  }

  function onAddInteraction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;

    startTransition(async () => {
      reset();
      const result = await addInteraction(client.id, interactionFields(new FormData(form)));

      if (!result.ok) {
        setFailure({ status: result.status, message: result.error });
        return;
      }

      form.reset();
      setAddingInteraction(false);
      setNotice("Interaction logged.");
    });
  }

  function onSaveInteraction(event: FormEvent<HTMLFormElement>, target: EditTarget) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);

    startTransition(async () => {
      reset();
      const result = await updateInteraction(
        client.id,
        target.id,
        interactionFields(data),
        // The version this interaction's form was populated from — see the note above.
        target.version,
      );

      if (!result.ok) {
        setFailure({ status: result.status, message: result.error });
        return;
      }

      setEditingInteraction(null);
      setNotice("Interaction saved.");
    });
  }

  function onDeleteInteraction(interaction: InteractionSummary) {
    const label = `${KIND_LABELS[interaction.kind]} on ${interaction.occurredOn.slice(0, 10)}`;
    if (!window.confirm(`Remove the ${label}? This cannot be undone.`)) {
      return;
    }

    startTransition(async () => {
      reset();
      const result = await deleteInteraction(client.id, interaction.id);
      if (!result.ok) {
        setFailure({ status: result.status, message: result.error });
        return;
      }

      setNotice("Interaction removed.");
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

  function onSaveContact(event: FormEvent<HTMLFormElement>, target: EditTarget) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);

    startTransition(async () => {
      reset();
      const result = await updateContact(
        client.id,
        target.id,
        {
          fullName: value(data, "fullName"),
          email: value(data, "email"),
          roleTitle: value(data, "roleTitle"),
          notes: value(data, "notes"),
        },
        // The version this contact's form was populated from — see the note above.
        target.version,
      );

      if (!result.ok) {
        setFailure({ status: result.status, message: result.error });
        return;
      }

      setEditingContact(null);
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

      {sideLoadFailed ? (
        <p className={styles.hint}>
          Some pipeline data (the status history or the interaction log) could not be loaded —
          reload to try again.
        </p>
      ) : null}

      <section className={styles.card}>
        <p className={styles.cardTitle}>Pipeline</p>
        <div className={styles.formGrid}>
          <div className={styles.field}>
            <span className={styles.label}>Status</span>
            <span>
              <span className={badgeClass(client.status)}>{STATUS_LABELS[client.status]}</span>
            </span>
          </div>
          <Detail label="Source" text={client.source} />
          <div className={styles.field}>
            <span className={styles.label}>Owner</span>
            <span>
              {client.owner === null ? (
                <span className={styles.count}>Unassigned</span>
              ) : (
                actorName(client.owner, myId)
              )}
            </span>
          </div>
          {client.acquiredAt ? (
            <Detail label="Acquired" text={client.acquiredAt.slice(0, 10)} />
          ) : null}
        </div>

        {client.lostReason ? (
          <div className={styles.field}>
            <span className={styles.label}>Lost because</span>
            <p className={styles.contactNote}>{client.lostReason}</p>
          </div>
        ) : null}

        <form className={styles.formActions} onSubmit={onChangeStatus}>
          <select
            className={styles.input}
            value={pendingStatus}
            aria-label="New status"
            disabled={isPending}
            onChange={(event) => setPendingStatus(event.target.value as ClientStatus)}
          >
            {CLIENT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
          {pendingStatus === "lost" ? (
            <input
              className={styles.input}
              name="lostReason"
              placeholder="Why was it lost? (optional)"
              maxLength={500}
              defaultValue={client.lostReason ?? ""}
            />
          ) : null}
          <button
            type="submit"
            className={`${styles.primary} ${styles.small}`}
            disabled={isPending}
          >
            {isPending ? "Saving…" : "Change status"}
          </button>
        </form>

        <div className={styles.formActions}>
          {myId && client.owner !== myId ? (
            <button
              type="button"
              className={`${styles.button} ${styles.small}`}
              disabled={isPending}
              onClick={() => onSetOwner(myId)}
            >
              Assign to me
            </button>
          ) : null}
          {client.owner !== null ? (
            <button
              type="button"
              className={`${styles.button} ${styles.small}`}
              disabled={isPending}
              onClick={() => onSetOwner(null)}
            >
              Unassign
            </button>
          ) : null}
          <span className={styles.hint}>
            Status changes are recorded below; a first move to Active client stamps the acquired
            date.
          </span>
        </div>

        {history.length > 0 ? (
          <div className={styles.history}>
            {history.map((entry) => (
              <span key={entry.id}>
                {STATUS_LABELS[entry.fromStatus]} → {STATUS_LABELS[entry.toStatus]} ·{" "}
                {entry.changedAt.slice(0, 10)} · {actorName(entry.changedBy, myId)}
              </span>
            ))}
          </div>
        ) : null}
      </section>

      {editing !== null ? (
        <form className={styles.card} onSubmit={(event) => onSave(event, editing)}>
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
            <label className={styles.field}>
              <span className={styles.label}>Source</span>
              <input
                className={styles.input}
                name="source"
                defaultValue={client.source ?? ""}
                maxLength={100}
                placeholder="referral, outbound, event…"
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
              onClick={() => setEditing(null)}
            >
              Cancel
            </button>
            {/* Clearing a field is how you clear it: PATCH replaces every field it is sent. */}
            <span className={styles.hint}>
              An emptied field is cleared, not left alone. Status and owner are managed in the
              pipeline panel.
            </span>
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
                // Capture the version now, in the same render the defaultValues come from.
                setEditing(client.version);
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
          {client.contacts.map((contact) => {
            // Narrowed to the snapshot taken when Edit was clicked, so the version handed to
            // onSaveContact always belongs to the same render as the inputs' defaultValues.
            const target = editingContact?.id === contact.id ? editingContact : null;

            return target ? (
              <li key={contact.id} className={styles.contact}>
                <form
                  className={styles.fullWidth}
                  onSubmit={(event) => onSaveContact(event, target)}
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
                      onClick={() => setEditingContact(null)}
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
                      setEditingContact({ id: contact.id, version: contact.version });
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
            );
          })}
        </ul>
      ) : null}

      <div className={styles.toolbar}>
        <span className={styles.meta}>
          {interactions.length === 0
            ? "No interactions logged"
            : `${interactions.length} interaction${interactions.length === 1 ? "" : "s"}`}
        </span>
        <button
          type="button"
          className={`${styles.button} ${styles.small}`}
          disabled={isPending}
          onClick={() => {
            setAddingInteraction((open) => !open);
            reset();
          }}
        >
          {addingInteraction ? "Cancel" : "Log interaction"}
        </button>
      </div>

      {addingInteraction ? (
        <form className={styles.card} onSubmit={onAddInteraction}>
          <p className={styles.cardTitle}>Log an interaction</p>
          <InteractionFormFields contacts={client.contacts} />
          <div className={styles.formActions}>
            <button type="submit" className={styles.primary} disabled={isPending}>
              {isPending ? "Saving…" : "Log"}
            </button>
            <span className={styles.hint}>The date it occurred and a summary are required.</span>
          </div>
        </form>
      ) : null}

      {interactions.length > 0 ? (
        <ul className={styles.contactList}>
          {interactions.map((interaction) => {
            // Same snapshot idiom as the contact editors: the version handed to
            // onSaveInteraction always belongs to the same render as the defaultValues.
            const target =
              editingInteraction?.id === interaction.id ? editingInteraction : null;
            const contact = interaction.contactId
              ? client.contacts.find((candidate) => candidate.id === interaction.contactId)
              : undefined;

            return target ? (
              <li key={interaction.id} className={styles.contact}>
                <form
                  className={styles.fullWidth}
                  onSubmit={(event) => onSaveInteraction(event, target)}
                >
                  <InteractionFormFields contacts={client.contacts} interaction={interaction} />
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
                      onClick={() => setEditingInteraction(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </li>
            ) : (
              <li key={interaction.id} className={styles.contact}>
                <div className={styles.contactBody}>
                  <span className={styles.contactName}>
                    <span className={styles.badge}>{KIND_LABELS[interaction.kind]}</span>
                    <span className={styles.count}> {interaction.occurredOn.slice(0, 10)}</span>
                    {contact ? (
                      <span className={styles.count}>
                        {" "}
                        · with {contact.fullName ?? contact.email}
                      </span>
                    ) : null}
                  </span>
                  <span className={styles.contactNote}>{interaction.summary}</span>
                  <span className={styles.count}>
                    {interaction.followUpOn
                      ? `Follow up ${interaction.followUpOn.slice(0, 10)} · `
                      : ""}
                    logged by {actorName(interaction.createdBy, myId)}
                  </span>
                </div>
                <div className={styles.rowActions}>
                  <button
                    type="button"
                    className={`${styles.button} ${styles.small}`}
                    disabled={isPending}
                    onClick={() => {
                      setEditingInteraction({
                        id: interaction.id,
                        version: interaction.version,
                      });
                      reset();
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className={`${styles.button} ${styles.small} ${styles.danger}`}
                    disabled={isPending}
                    onClick={() => onDeleteInteraction(interaction)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
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
        {/* Deliberately NOT type="email". The browser's built-in check is stricter than the
            API's `IsPlausibleEmail`, which tolerates a trailing dot on purpose — three seeded
            contacts have addresses ending in a full stop, and the two validators (C# and the
            importer) were aligned specifically so those rows stay editable. type="email" would
            re-impose the rejection here and block the form outright, so you could not even fix
            such a contact's role without first altering an address that is correct as recorded.
            inputMode keeps the mobile keyboard; the server stays the single source of truth. */}
        <input
          className={styles.input}
          name="email"
          type="text"
          inputMode="email"
          autoComplete="email"
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

/**
 * The interaction add/edit fields, shared like {@link ContactFields}. The date inputs start
 * blank rather than defaulting to "today": computing today in a defaultValue would render one
 * date during SSR and possibly another after hydration.
 */
function InteractionFormFields({
  contacts,
  interaction,
}: {
  contacts: ContactSummary[];
  interaction?: InteractionSummary;
}) {
  return (
    <div className={styles.formGrid}>
      <label className={styles.field}>
        <span className={styles.label}>Kind</span>
        <select className={styles.input} name="kind" defaultValue={interaction?.kind ?? "note"}>
          {INTERACTION_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {KIND_LABELS[kind]}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Date (required)</span>
        <input
          className={styles.input}
          type="date"
          name="occurredOn"
          required
          defaultValue={interaction?.occurredOn.slice(0, 10) ?? ""}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Follow up on</span>
        <input
          className={styles.input}
          type="date"
          name="followUpOn"
          defaultValue={interaction?.followUpOn?.slice(0, 10) ?? ""}
        />
      </label>
      {contacts.length > 0 ? (
        <label className={styles.field}>
          <span className={styles.label}>Contact</span>
          <select
            className={styles.input}
            name="contactId"
            defaultValue={interaction?.contactId ?? ""}
          >
            <option value="">—</option>
            {contacts.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.fullName ?? contact.email ?? "Unnamed contact"}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className={`${styles.field} ${styles.wide}`}>
        <span className={styles.label}>Summary (required)</span>
        <textarea
          className={styles.textarea}
          name="summary"
          required
          maxLength={2000}
          defaultValue={interaction?.summary ?? ""}
        />
      </label>
    </div>
  );
}

/** Reads {@link InteractionFormFields}'s inputs into the shape the actions send. */
function interactionFields(data: FormData): InteractionFields {
  return {
    kind: String(data.get("kind") ?? "note") as InteractionKind,
    // `<input type="date">` produces yyyy-MM-dd, which is exactly what the API's DateOnly reads.
    occurredOn: String(data.get("occurredOn") ?? ""),
    summary: value(data, "summary") ?? "",
    followUpOn: value(data, "followUpOn"),
    contactId: value(data, "contactId"),
  };
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
 * A Clerk subject rendered for humans: "you" for the signed-in user, the import sentinel named,
 * and anyone else's id shortened — there is no user directory yet to resolve it to a name.
 */
function actorName(actor: string, myId: string | null): string {
  if (actor === IMPORT_SENTINEL) {
    return "the outreach spreadsheet";
  }
  if (myId !== null && actor === myId) {
    return "you";
  }
  return actor.length > 16 ? `${actor.slice(0, 10)}…${actor.slice(-4)}` : actor;
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
