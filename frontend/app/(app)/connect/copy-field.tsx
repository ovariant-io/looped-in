"use client";

import { useEffect, useState } from "react";
import styles from "./connect.module.css";

/**
 * Copy-to-clipboard field for the connector URL. Client-only — it needs the
 * clipboard API and a brief "Copied" acknowledgement that resets after 2s.
 * The URL itself is resolved on the server and passed in as a prop.
 *
 * The clipboard call is guarded because it genuinely fails in situations this page
 * is used in: `navigator.clipboard` is undefined outside a secure context (any
 * non-localhost HTTP origin — e.g. reaching a dev box by LAN address), and the write
 * can be rejected by permissions. Unguarded, both left the button doing nothing at
 * all, with an unhandled rejection or TypeError as the only trace.
 */
export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    setFailed(false);
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setFailed(true);
    }
  }

  return (
    <>
      <div className={styles.copyField}>
        <code className={styles.copyValue}>{value}</code>
        <button
          type="button"
          className={styles.copyButton}
          onClick={() => void copy()}
          aria-label={`Copy ${label}`}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {/* Sibling, not a child: .copyField is a single flex row. */}
      {failed ? (
        <p className={styles.copyError} role="status">
          Couldn&apos;t copy automatically — select the link above and copy it by
          hand. (The clipboard is unavailable unless the page is served over
          HTTPS or from localhost.)
        </p>
      ) : null}
    </>
  );
}
