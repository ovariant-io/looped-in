import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Geist, Geist_Mono, Space_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// The brand site sets its meta/label font to Space Mono. It carries the eyebrows
// and small caps labels; Geist Mono stays the *code* face (connector URLs, claim
// names), so the two monospaces are never doing the same job.
// Not a variable font, so the weights have to be named.
const spaceMono = Space_Mono({
  variable: "--font-space-mono",
  weight: ["400", "700"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // Pages that set their own title (/me, /connect, /documents) override this; it is the
  // fallback for anything that doesn't, and the tab title on the landing page.
  title: "Looped In",
  description:
    "Looped In — your documents and your AI assistants, on one authenticated account.",
};

/**
 * Root layout — fonts, tokens, and the Clerk provider, and nothing else.
 *
 * There is deliberately no chrome here. The app has two shapes and they do not share
 * a frame: the signed-out landing page and the auth pages are stand-alone full-bleed
 * screens rendered straight under this layout, while everything behind sign-in is
 * wrapped by the sidebar shell in `app/(app)/layout.tsx`. Putting a header here is
 * what previously forced the landing page to wear the app's chrome.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${spaceMono.variable}`}
    >
      <body>
        <ClerkProvider>{children}</ClerkProvider>
      </body>
    </html>
  );
}
