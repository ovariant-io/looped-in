"use client";

import { useEffect, useState } from "react";
import styles from "./connect.module.css";

/**
 * Copy-to-clipboard field for the connector URL. Client-only — it needs the
 * clipboard API and a brief "Copied" acknowledgement that resets after 2s.
 * The URL itself is resolved on the server and passed in as a prop.
 */
export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className={styles.copyField}>
      <code className={styles.copyValue}>{value}</code>
      <button
        type="button"
        className={styles.copyButton}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => setCopied(true));
        }}
        aria-label={`Copy ${label}`}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
