import type { Metadata } from "next";
import { Suspense } from "react";
import { callBackend } from "@/app/lib/backend";
import { DocumentManager } from "./document-manager";
import type { DocumentListResponse } from "./types";
import styles from "./documents.module.css";

export const metadata: Metadata = {
  title: "Documents",
  description: "Upload, rename, download, and delete your documents.",
};

export default function DocumentsPage() {
  return (
    <main className={styles.main}>
      <h1 className={styles.title}>Documents</h1>
      <p className={styles.intro}>
        Your documents live in S3 under a key derived from your account, so no
        request can reach another user&apos;s files. Uploads and downloads go
        directly between your browser and S3 over short-lived signed URLs — the
        API hands out the URL but never carries the bytes.
      </p>
      {/* auth() and the no-store fetch are request-dynamic, so the dynamic work lives in its
          own Suspense boundary. Cache Components is currently off (see next.config.ts); the
          boundary is kept so it can be re-enabled. */}
      <Suspense
        fallback={<p className={styles.muted}>Loading your documents…</p>}
      >
        <DocumentLibrary />
      </Suspense>
    </main>
  );
}

async function DocumentLibrary() {
  const result = await callBackend<DocumentListResponse>("/documents");

  if (!result.ok) {
    return (
      <section className={`${styles.card} ${styles.error}`}>
        <p className={styles.cardTitle}>
          {result.status === 503
            ? "📦 Document storage isn't configured yet"
            : `❌ Could not load your documents${
                result.status ? ` (${result.status})` : ""
              }`}
        </p>
        <p className={styles.muted}>{result.error}</p>
        {result.status === 503 ? (
          <p className={styles.hint}>
            The API is running but has no S3 bucket. Set{" "}
            <code>Documents__Bucket</code> (and <code>AWS_REGION</code>) in{" "}
            <code>backend/.env.local</code> for local development — deployed
            stages get both from the SST stack automatically.
          </p>
        ) : null}
        {result.status === 401 ? (
          <p className={styles.hint}>
            401 — the token was rejected. Check that the backend&apos;s{" "}
            <code>Clerk:Authority</code> matches this frontend&apos;s Clerk
            instance.
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <DocumentManager
      documents={result.data.documents}
      truncated={result.data.truncated}
    />
  );
}
