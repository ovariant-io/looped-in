import Link from "next/link";
import styles from "./page.module.css";

// The loop, stated once. Each node is a real part of the stack — "Your data" is
// /documents (S3), "Looped In" is the Clerk-authenticated API, "Your AI tools"
// is the MCP server — so the picture stays honest as the product fills in.
const LOOP = [
  {
    step: "01",
    title: "Your data",
    body: "Documents you upload, held against your account and nobody else's.",
  },
  {
    step: "02",
    title: "Looped In",
    body: "One sign-in holds the loop closed — a single authenticated channel.",
  },
  {
    step: "03",
    title: "Your AI tools",
    body: "Claude and any MCP client, acting as you, seeing only what you see.",
  },
];

export default function Home() {
  return (
    <main className={styles.main}>
      <section className={styles.hero}>
        <p className={styles.eyebrow}>Your data · Your AI tools</p>
        <h1 className={styles.title}>Let&rsquo;s get your data Looped In</h1>
        <p className={styles.lede}>
          Everything you upload lives in one place — and connects straight to
          the AI assistants you already use, over a link that only ever sees
          what you see.
        </p>
      </section>

      {/* The connecting rules between nodes are drawn by CSS pseudo-elements
          rather than markup, so the nodes stay exactly equal-width and the
          links can rotate from horizontal to vertical when the row stacks. */}
      <section
        className={styles.loop}
        aria-label="How Looped In connects your data to your AI tools"
      >
        {LOOP.map((node, index) => (
          <article
            key={node.step}
            className={`${styles.node}${index === 1 ? ` ${styles.anchor}` : ""}`}
          >
            <p className={styles.nodeStep}>{node.step}</p>
            <h2 className={styles.nodeTitle}>{node.title}</h2>
            <p className={styles.nodeBody}>{node.body}</p>
          </article>
        ))}
      </section>

      <nav className={styles.actions} aria-label="Get started">
        <Link href="/documents" className={styles.primaryAction}>
          Your data
        </Link>
        <Link href="/connect" className={styles.secondaryAction}>
          Connect AI
        </Link>
      </nav>
    </main>
  );
}
