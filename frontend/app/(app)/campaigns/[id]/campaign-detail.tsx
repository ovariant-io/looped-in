"use client";

import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { FailureBanner, type EditTarget, type Failure } from "@/app/(app)/clients/client-manager";
import type { ClientSummary } from "@/app/(app)/clients/types";
import { renderEmailHtml, renderEmailText } from "@/app/lib/email-template";
import {
  addMessage,
  deleteCampaign,
  deleteMessage,
  setMessageState,
  updateCampaign,
  updateMessage,
} from "../actions";
import { stateBadgeClass } from "../campaign-manager";
import {
  CAMPAIGN_MESSAGE_STATES,
  MESSAGE_STATE_LABELS,
  type CampaignDetail,
  type CampaignMessage,
  type CampaignMessageState,
  type MessageFields,
} from "../types";
import styles from "../campaigns.module.css";

/**
 * One campaign and its drafts.
 *
 * Renders straight from props like every manager — mutations go through Server Actions that call
 * `refresh()` and new props arrive. The concurrency rules are the client detail page's, applied
 * to messages:
 *
 * - **An open edit form holds the version its inputs were populated from** (the `EditTarget`
 *   snapshot) — uncontrolled inputs freeze at mount while props keep arriving, so a version read
 *   at save time could silently overwrite someone else's edit instead of 409ing.
 * - **The state control submits live `message.version`, which is honest only because
 *   `<StateForm>` is keyed on `message.state`** — a transition arriving from the server remounts
 *   the control and discards any half-made selection, so the submitted state and version always
 *   describe one row. Same reasoning as the client `StatusForm`.
 */
export function CampaignDetailView({
  campaign,
  clientOptions,
  pickerLoadFailed,
}: {
  campaign: CampaignDetail;
  clientOptions: ClientSummary[];
  pickerLoadFailed: boolean;
}) {
  const router = useRouter();
  // Renders the caller's own Clerk id as "you" — display sugar only; writes derive the actor
  // from the token server-side.
  const { user } = useUser();
  const myId = user?.id ?? null;
  const [isPending, startTransition] = useTransition();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [addingMessage, setAddingMessage] = useState(false);
  const [editingMessage, setEditingMessage] = useState<EditTarget | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);

  const drafted = new Set(campaign.messages.map((message) => message.clientId));

  function reset() {
    setFailure(null);
    setNotice(null);
  }

  function onSaveCampaign(event: FormEvent<HTMLFormElement>, expectedVersion: number) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);

    startTransition(async () => {
      reset();
      const result = await updateCampaign(
        campaign.id,
        {
          name: value(data, "name") ?? "",
          brief: value(data, "brief"),
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

  function onDeleteCampaign() {
    const messages =
      campaign.messages.length === 0
        ? ""
        : ` and its ${campaign.messages.length} message${campaign.messages.length === 1 ? "" : "s"}`;

    if (!window.confirm(`Delete “${campaign.name}”${messages}? This cannot be undone.`)) {
      return;
    }

    startTransition(async () => {
      reset();
      const result = await deleteCampaign(campaign.id);
      if (!result.ok) {
        setFailure({ status: result.status, message: result.error });
        return;
      }

      router.push("/campaigns");
    });
  }

  function onAddMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const clientId = String(data.get("clientId") ?? "");

    startTransition(async () => {
      reset();
      const result = await addMessage(campaign.id, clientId, {
        subject: value(data, "subject") ?? "",
        body: value(data, "body") ?? "",
        // The recipient is chosen on the message card afterwards: its options come from
        // contactOptions, which only covers clients already in the campaign — this client
        // joins that set the moment the draft lands.
        contactId: null,
      });

      if (!result.ok) {
        setFailure({ status: result.status, message: result.error });
        return;
      }

      form.reset();
      setAddingMessage(false);
      setNotice(`Drafted for ${result.data.clientName}.`);
    });
  }

  function onSaveMessage(event: FormEvent<HTMLFormElement>, target: EditTarget) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);

    startTransition(async () => {
      reset();
      const result = await updateMessage(
        campaign.id,
        target.id,
        messageFields(data),
        // The version this message's form was populated from — see the note above.
        target.version,
      );

      if (!result.ok) {
        setFailure({ status: result.status, message: result.error });
        return;
      }

      setEditingMessage(null);
      setNotice("Message saved.");
    });
  }

  function onSetState(message: CampaignMessage, next: CampaignMessageState) {
    if (
      next === "sent" &&
      message.state !== "sent" &&
      !window.confirm(
        `Mark the email to ${message.clientName} as sent? This records the send and logs an ` +
          "email interaction on the client.",
      )
    ) {
      return;
    }

    startTransition(async () => {
      reset();
      // Live version — honest only because <StateForm> is keyed on message.state; see above.
      const result = await setMessageState(campaign.id, message.id, next, message.version);

      if (!result.ok) {
        setFailure({ status: result.status, message: result.error });
        return;
      }

      setNotice(
        next === "sent"
          ? `Recorded the send to ${result.data.clientName} — it is on the client's log.`
          : `${result.data.clientName}'s message is now ${MESSAGE_STATE_LABELS[result.data.state]}.`,
      );
    });
  }

  function onDeleteMessage(message: CampaignMessage) {
    if (
      !window.confirm(
        `Remove the draft for “${message.clientName}”? This cannot be undone. ` +
          "(A draft the team decided not to send should be Skipped instead.)",
      )
    ) {
      return;
    }

    startTransition(async () => {
      reset();
      const result = await deleteMessage(campaign.id, message.id);
      if (!result.ok) {
        setFailure({ status: result.status, message: result.error });
        return;
      }

      setNotice("Draft removed.");
    });
  }

  function copyToClipboard(text: string, label: string) {
    reset();
    navigator.clipboard.writeText(text).then(
      () => setNotice(`${label} copied.`),
      () => setFailure({ status: 0, message: "Could not write to the clipboard." }),
    );
  }

  return (
    <div className={styles.manager}>
      <h1 className={styles.title}>{campaign.name}</h1>

      <div className={styles.provenance}>
        <span>{describeActor("Created", campaign.createdBy, campaign.createdAt, myId)}</span>
        <span>{describeActor("Updated", campaign.updatedBy, campaign.updatedAt, myId)}</span>
        <span>v{campaign.version}</span>
      </div>

      {failure ? <FailureBanner failure={failure} onReload={() => router.refresh()} /> : null}

      {notice ? (
        <section className={`${styles.card} ${styles.notice}`}>
          <p className={styles.muted}>{notice}</p>
        </section>
      ) : null}

      {pickerLoadFailed ? (
        <p className={styles.hint}>
          The client list could not be loaded, so new drafts cannot be added right now — reload
          to try again.
        </p>
      ) : null}

      {editing !== null ? (
        <form className={styles.card} onSubmit={(event) => onSaveCampaign(event, editing)}>
          <p className={styles.cardTitle}>Edit campaign</p>
          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span className={styles.label}>Name (required)</span>
              <input
                className={styles.input}
                name="name"
                defaultValue={campaign.name}
                required
                maxLength={200}
                autoFocus
              />
            </label>
            <label className={`${styles.field} ${styles.wide}`}>
              <span className={styles.label}>Brief</span>
              <textarea
                className={styles.textarea}
                name="brief"
                defaultValue={campaign.brief ?? ""}
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
            <span className={styles.hint}>An emptied brief is cleared, not left alone.</span>
          </div>
        </form>
      ) : (
        <section className={styles.card}>
          <p className={styles.cardTitle}>Brief</p>
          {campaign.brief ? (
            <p className={styles.brief}>{campaign.brief}</p>
          ) : (
            <p className={styles.muted}>
              No brief yet. The brief is the drafting instruction — who the campaign is for, the
              offer, the voice — and a connected assistant reads it before drafting.
            </p>
          )}
          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.button}
              disabled={isPending}
              onClick={() => {
                // Capture the version now, in the same render the defaultValues come from.
                setEditing(campaign.version);
                reset();
              }}
            >
              Edit campaign
            </button>
            <button
              type="button"
              className={`${styles.button} ${styles.danger}`}
              disabled={isPending}
              onClick={onDeleteCampaign}
            >
              Delete campaign
            </button>
          </div>
        </section>
      )}

      <div className={styles.toolbar}>
        <span className={styles.meta}>
          {campaign.messages.length === 0
            ? "No drafts yet"
            : `${campaign.messages.length} draft${campaign.messages.length === 1 ? "" : "s"}`}
        </span>
        <button
          type="button"
          className={`${styles.button} ${styles.small}`}
          disabled={isPending || (clientOptions.length === 0 && !addingMessage)}
          onClick={() => {
            setAddingMessage((open) => !open);
            reset();
          }}
        >
          {addingMessage ? "Cancel" : "Add draft"}
        </button>
      </div>

      {addingMessage ? (
        <form className={styles.card} onSubmit={onAddMessage}>
          <p className={styles.cardTitle}>New draft</p>
          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span className={styles.label}>Client (required)</span>
              {/* One draft per client per campaign, and never to do_not_contact — both rules
                  are surfaced here as disabled options (UI-level suppression; the API enforces
                  only the uniqueness, as a 409 naming the fix). */}
              <select className={styles.input} name="clientId" required defaultValue="">
                <option value="" disabled>
                  Choose a client…
                </option>
                {[...clientOptions]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((client) => {
                    const suppressed = client.status === "do_not_contact";
                    const already = drafted.has(client.id);
                    return (
                      <option
                        key={client.id}
                        value={client.id}
                        disabled={suppressed || already}
                      >
                        {client.name}
                        {suppressed ? " — do not contact" : already ? " — already drafted" : ""}
                      </option>
                    );
                  })}
              </select>
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Subject (required)</span>
              <input className={styles.input} name="subject" required maxLength={200} />
            </label>
            <label className={`${styles.field} ${styles.wide}`}>
              <span className={styles.label}>Body (required)</span>
              <textarea
                className={styles.bodyTextarea}
                name="body"
                required
                maxLength={10000}
              />
            </label>
          </div>
          <div className={styles.formActions}>
            <button type="submit" className={styles.primary} disabled={isPending}>
              {isPending ? "Saving…" : "Add draft"}
            </button>
            <span className={styles.hint}>
              Plain text — a blank line starts a new paragraph. The recipient is chosen on the
              draft afterwards.
            </span>
          </div>
        </form>
      ) : null}

      {campaign.messages.length > 0 ? (
        <ul className={styles.messageList}>
          {campaign.messages.map((message) => {
            // Narrowed to the snapshot taken when Edit was clicked, so the version handed to
            // onSaveMessage always belongs to the same render as the inputs' defaultValues.
            const target = editingMessage?.id === message.id ? editingMessage : null;
            const recipients = campaign.contactOptions.filter(
              (option) => option.clientId === message.clientId,
            );

            return (
              <li key={message.id} className={styles.message}>
                <div className={styles.messageHead}>
                  <span className={styles.messageSubject}>
                    <Link href={`/clients/${message.clientId}`} className={styles.nameLink}>
                      {message.clientName}
                    </Link>
                    <span className={styles.count}>
                      {" "}
                      · {message.contactName ?? "no recipient"}
                    </span>
                  </span>
                  <span className={styles.chips}>
                    <span className={stateBadgeClass(message.state)}>
                      {MESSAGE_STATE_LABELS[message.state]}
                    </span>
                    {message.sentAt ? (
                      <span className={styles.count}>sent {message.sentAt.slice(0, 10)}</span>
                    ) : null}
                  </span>
                </div>

                {target ? (
                  <form
                    className={styles.fullWidth}
                    onSubmit={(event) => onSaveMessage(event, target)}
                  >
                    <div className={styles.formGrid}>
                      <label className={styles.field}>
                        <span className={styles.label}>Subject (required)</span>
                        <input
                          className={styles.input}
                          name="subject"
                          defaultValue={message.subject}
                          required
                          maxLength={200}
                          autoFocus
                        />
                      </label>
                      <label className={styles.field}>
                        <span className={styles.label}>Recipient</span>
                        <select
                          className={styles.input}
                          name="contactId"
                          defaultValue={message.contactId ?? ""}
                        >
                          <option value="">No recipient</option>
                          {recipients.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.fullName ?? option.email ?? "Unnamed contact"}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className={`${styles.field} ${styles.wide}`}>
                        <span className={styles.label}>Body (required)</span>
                        <textarea
                          className={styles.bodyTextarea}
                          name="body"
                          defaultValue={message.body}
                          required
                          maxLength={10000}
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
                        onClick={() => setEditingMessage(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    <span className={styles.messageSubject}>{message.subject}</span>
                    <p className={styles.messageText}>{message.body}</p>

                    {previewing === message.id ? (
                      // Fully sandboxed (sandbox="" grants nothing — no scripts, no navigation)
                      // and srcDoc is first-party HTML from the template with every
                      // interpolation escaped. A new precedent for the app, safe by
                      // construction; see email-template.ts.
                      <iframe
                        className={styles.previewFrame}
                        sandbox=""
                        srcDoc={renderEmailHtml({
                          subject: message.subject,
                          bodyText: message.body,
                        })}
                        title={`Email preview for ${message.clientName}`}
                      />
                    ) : null}

                    <div className={styles.formActions}>
                      <StateForm
                        key={message.state}
                        state={message.state}
                        isPending={isPending}
                        onSubmit={(next) => onSetState(message, next)}
                      />
                      <button
                        type="button"
                        className={`${styles.button} ${styles.small}`}
                        disabled={isPending}
                        onClick={() =>
                          setPreviewing((current) =>
                            current === message.id ? null : message.id,
                          )
                        }
                      >
                        {previewing === message.id ? "Hide preview" : "Preview"}
                      </button>
                      <button
                        type="button"
                        className={`${styles.button} ${styles.small}`}
                        disabled={isPending}
                        onClick={() =>
                          copyToClipboard(
                            renderEmailHtml({
                              subject: message.subject,
                              bodyText: message.body,
                            }),
                            "HTML",
                          )
                        }
                      >
                        Copy HTML
                      </button>
                      <button
                        type="button"
                        className={`${styles.button} ${styles.small}`}
                        disabled={isPending}
                        onClick={() =>
                          copyToClipboard(
                            renderEmailText({
                              subject: message.subject,
                              bodyText: message.body,
                            }),
                            "Text",
                          )
                        }
                      >
                        Copy text
                      </button>
                      <button
                        type="button"
                        className={`${styles.button} ${styles.small}`}
                        disabled={isPending}
                        onClick={() => {
                          setEditingMessage({ id: message.id, version: message.version });
                          reset();
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className={`${styles.button} ${styles.small} ${styles.danger}`}
                        disabled={isPending}
                        onClick={() => onDeleteMessage(message)}
                      >
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The message state control — its own component so it can be keyed on the message's current
 * state, exactly like the client `StatusForm`: the pending selection must not survive a
 * transition arriving from the server, because the parent submits live `message.version` and a
 * stale selection paired with a fresh version would silently revert someone else's move.
 */
function StateForm({
  state,
  isPending,
  onSubmit,
}: {
  state: CampaignMessageState;
  isPending: boolean;
  onSubmit: (next: CampaignMessageState) => void;
}) {
  const [pending, setPending] = useState<CampaignMessageState>(state);

  return (
    <form
      className={styles.formActions}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(pending);
      }}
    >
      <select
        className={styles.input}
        value={pending}
        aria-label="New state"
        disabled={isPending}
        onChange={(event) => setPending(event.target.value as CampaignMessageState)}
      >
        {CAMPAIGN_MESSAGE_STATES.map((option) => (
          <option key={option} value={option}>
            {MESSAGE_STATE_LABELS[option]}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className={`${styles.primary} ${styles.small}`}
        disabled={isPending || pending === state}
      >
        {isPending ? "Saving…" : "Set state"}
      </button>
    </form>
  );
}

/** Reads the message form's inputs into the shape the actions send. */
function messageFields(data: FormData): MessageFields {
  return {
    subject: value(data, "subject") ?? "",
    body: value(data, "body") ?? "",
    contactId: value(data, "contactId"),
  };
}

/** A Clerk subject rendered for humans — "you" for the signed-in user, others shortened. */
function actorName(actor: string, myId: string | null): string {
  if (myId !== null && actor === myId) {
    return "you";
  }
  return actor.length > 16 ? `${actor.slice(0, 10)}…${actor.slice(-4)}` : actor;
}

function describeActor(verb: string, actor: string, at: string, myId: string | null): string {
  return `${verb} ${at.slice(0, 10)} · ${actorName(actor, myId)}`;
}

/** Trimmed form value; empty means "clear this field", because PATCH replaces rather than merges. */
function value(data: FormData, key: string): string | null {
  const text = String(data.get(key) ?? "").trim();
  return text === "" ? null : text;
}
