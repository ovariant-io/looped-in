import { ClerkProvider } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
import "./globals.css";
import { HeaderNav } from "./header-nav";
import styles from "./header.module.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // Pages that set their own title (/me, /connect, /documents) override this; it is the
  // fallback for anything that doesn't, and the tab title on the home page.
  title: "Looped In",
  description:
    "Looped In — your documents and your AI assistants, on one authenticated account.",
};

// Server slot: resolve the real auth state for THIS request and seed the client
// nav with it, so the correct buttons render on first paint. `await auth()` is
// request-dynamic, so this lives behind the <Suspense> boundary below.
async function HeaderNavSlot() {
  const { userId } = await auth();
  return <HeaderNav initialSignedIn={userId != null} />;
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        <ClerkProvider>
          <header className={styles.header}>
            <Link href="/" className={styles.brand}>
              Looped In
            </Link>
            {/* Auth-reactive nav: the server slot seeds the correct buttons for
                this request (no blank first paint); the client component then
                tracks Clerk's live session so it updates without a refresh. */}
            <Suspense
              fallback={<div className={styles.placeholder} aria-hidden />}
            >
              <HeaderNavSlot />
            </Suspense>
          </header>
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
