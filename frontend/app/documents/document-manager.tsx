"use client";

import { useRef, useState, useTransition, type ChangeEvent, type FormEvent } from "react";
import {
  completeUpload,
  createUploadTarget,
  deleteDocument,
  getDownloadUrl,
  renameDocument,
} from "./actions";
import type { DocumentSummary } from "./types";
import styles from "./documents.module.css";

/**
 * The interactive half of the documents page.
 *
 * Deliberately holds **no copy** of the document list: it renders straight from props, and the
 * mutating Server Actions call `refresh()`, so the server re-renders and new props arrive. A
 * local `useState` mirror would go stale the moment a rename or delete landed. Local state here
 * covers only what the server does not know about — which upload is in flight, which row is being
 * renamed, and the last error.
 */
export function DocumentManager({
  documents,
  truncated,
}: {
  documents: DocumentSummary[];
  truncated: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  function onFilesPicked(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    // Clear the input so picking the same file twice in a row still fires a change event.
    event.target.value = "";
    if (picked.length === 0) {
      return;
    }

    startTransition(async () => {
      setError(null);

      for (const [index, file] of picked.entries()) {
        setStatus(
          picked.length > 1
            ? `Uploading ${file.name} (${index + 1} of ${picked.length})…`
            : `Uploading ${file.name}…`,
        );

        // 1. Reserve an id and get a presigned PUT. Nothing exists in S3 yet.
        const target = await createUploadTarget(file.name, file.type);
        if (!target.ok) {
          setError(target.error);
          setStatus(null);
          return;
        }

        // 2. Send the bytes straight to S3. This is the only request in the whole app that
        //    goes anywhere other than our own backend, and the presigned URL is what
        //    authorizes it — no Clerk token is involved or exposed.
        try {
          const uploaded = await fetch(target.data.uploadUrl, {
            method: "PUT",
            // Verbatim: these headers are covered by the signature.
            headers: target.data.requiredHeaders,
            body: file,
          });

          if (!uploaded.ok) {
            setError(
              `S3 rejected the upload of "${file.name}" (HTTP ${uploaded.status}). ` +
                "The presigned URL may have expired — try again.",
            );
            setStatus(null);
            return;
          }
        } catch {
          // fetch() rejects rather than returning a status when the browser blocks the
          // response, which for a direct-to-S3 PUT almost always means bucket CORS.
          setError(
            `The browser could not reach S3 to upload "${file.name}". This is usually the ` +
              "bucket's CORS rules not allowing this origin.",
          );
          setStatus(null);
          return;
        }

        // 3. Confirm it landed, and let the server re-render the list.
        const completed = await completeUpload(target.data.id);
        if (!completed.ok) {
          setError(completed.error);
          setStatus(null);
          return;
        }
      }

      setStatus(null);
    });
  }

  function onDownload(document: DocumentSummary) {
    startTransition(async () => {
      setError(null);
      const result = await getDownloadUrl(document.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }

      // A top-level navigation, not a fetch: it is not a CORS request at all, and the API
      // signed the URL with Content-Disposition: attachment, so the browser saves the file
      // under its original name and leaves this page where it is.
      window.location.href = result.data.downloadUrl;
    });
  }

  function onDelete(document: DocumentSummary) {
    if (!window.confirm(`Delete "${document.filename}"? This cannot be undone.`)) {
      return;
    }

    startTransition(async () => {
      setError(null);
      setStatus(`Deleting ${document.filename}…`);
      const result = await deleteDocument(document.id);
      setStatus(null);
      if (!result.ok) {
        setError(result.error);
      }
    });
  }

  function onRenameSubmit(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    const filename = renameDraft.trim();
    if (!filename) {
      return;
    }

    startTransition(async () => {
      setError(null);
      const result = await renameDocument(id, filename);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRenamingId(null);
    });
  }

  function startRenaming(document: DocumentSummary) {
    setRenamingId(document.id);
    setRenameDraft(document.filename);
    setError(null);
  }

  return (
    <div className={styles.manager}>
      <section className={styles.uploader}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className={styles.fileInput}
          onChange={onFilesPicked}
          disabled={isPending}
        />
        <button
          type="button"
          className={styles.primaryButton}
          onClick={() => fileInputRef.current?.click()}
          disabled={isPending}
        >
          Upload documents
        </button>
        <p className={styles.uploaderHint}>
          Files go straight from your browser to S3 using a short-lived signed
          URL — they never pass through the API.
        </p>
      </section>

      {status ? <p className={styles.status}>{status}</p> : null}

      {error ? (
        <section className={`${styles.card} ${styles.error}`}>
          <p className={styles.cardTitle}>❌ Something went wrong</p>
          <p className={styles.muted}>{error}</p>
        </section>
      ) : null}

      {documents.length === 0 ? (
        <section className={styles.card}>
          <p className={styles.cardTitle}>No documents yet</p>
          <p className={styles.muted}>
            Upload your first file and it will appear here. Only you can see it:
            every document is stored under a key derived from your account.
          </p>
        </section>
      ) : (
        <ul className={styles.list}>
          {documents.map((document) => (
            <li key={document.id} className={styles.item}>
              {renamingId === document.id ? (
                <form
                  className={styles.renameForm}
                  onSubmit={(event) => onRenameSubmit(event, document.id)}
                >
                  <input
                    className={styles.renameInput}
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    aria-label="New filename"
                    autoFocus
                    disabled={isPending}
                  />
                  <button
                    type="submit"
                    className={styles.smallButton}
                    disabled={isPending}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className={styles.smallButton}
                    onClick={() => setRenamingId(null)}
                    disabled={isPending}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <div className={styles.itemMeta}>
                    <span className={styles.filename}>{document.filename}</span>
                    <span className={styles.detail} title={document.lastModified}>
                      {formatSize(document.size)} ·{" "}
                      {formatTimestamp(document.lastModified)}
                    </span>
                  </div>
                  <div className={styles.itemActions}>
                    <button
                      type="button"
                      className={styles.smallButton}
                      onClick={() => onDownload(document)}
                      disabled={isPending}
                    >
                      Download
                    </button>
                    <button
                      type="button"
                      className={styles.smallButton}
                      onClick={() => startRenaming(document)}
                      disabled={isPending}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className={`${styles.smallButton} ${styles.danger}`}
                      onClick={() => onDelete(document)}
                      disabled={isPending}
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {truncated ? (
        <p className={styles.hint}>
          Showing the oldest batch of your documents — you have more than this
          view lists in one request.
        </p>
      ) : null}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Formats the ISO timestamp without locale or timezone lookups on purpose: this component is
 * server-rendered and then hydrated, and `toLocaleString()` would resolve differently in the two
 * passes, producing a hydration mismatch. The full value is on the element's `title`.
 */
function formatTimestamp(iso: string): string {
  return iso.length >= 16
    ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
    : iso;
}
