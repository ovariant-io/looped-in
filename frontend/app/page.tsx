import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.main}>
      <h1 className={styles.title}>Hello, World 👋</h1>
      <p className={styles.subtitle}>Next.js 16 · React 19</p>
    </main>
  );
}
