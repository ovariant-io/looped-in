"use client";

import { useEffect, useState } from "react";
import styles from "./connect.module.css";

/**
 * Copy-to-clipboard widgets: `CopyField` for a one-line value (the connector
 * URL), `CopyBlock` for multi-line text (the assistant prompt). Client-only —
 * they need the clipboard API and a brief "Copied" acknowledgement that resets
 * after 2s. The values themselves are resolved elsewhere and passed as props.
 *
 * The clipboard call is guarded because it genuinely fails in situations this page
 * is used in: `navigator.clipboard` is undefined outside a secure context (any
 * non-localhost HTTP origin — e.g. reaching a dev box by LAN address), and the write
 * can be rejected by permissions. Unguarded, both left the button doing nothing at
 * all, with an unhandled rejection or TypeError as the only trace.
 */
function useCopy(value: string) {
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

  return { copied, failed, copy };
}

function CopyError({ what }: { what: string }) {
  return (
    <p className={styles.copyError} role="status">
      Couldn&apos;t copy automatically — select the {what} and copy it by hand.
      (The clipboard is unavailable unless the page is served over HTTPS or
      from localhost.)
    </p>
  );
}

export function CopyField({ value, label }: { value: string; label: string }) {
  const { copied, failed, copy } = useCopy(value);

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
      {failed ? <CopyError what="link above" /> : null}
    </>
  );
}

export function CopyBlock({ value, label }: { value: string; label: string }) {
  const { copied, failed, copy } = useCopy(value);

  return (
    <>
      <div className={styles.copyBlock}>
        <div className={styles.copyBlockBar}>
          <span className={styles.copyBlockLabel}>{label}</span>
          <button
            type="button"
            className={styles.copyButton}
            onClick={() => void copy()}
            aria-label={`Copy ${label}`}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <pre className={styles.copyBlockText}>{value}</pre>
      </div>
      {failed ? <CopyError what="text above" /> : null}
    </>
  );
}
