import type { Metadata } from "next";
import { Familjen_Grotesk, Martian_Mono } from "next/font/google";
import "./globals.css";

// Self-hosted at build time. Martian Mono keeps its width axis: wide for the
// claim in the band, condensed for wire data and the trace log.
const martianMono = Martian_Mono({ subsets: ["latin"], axes: ["wdth"], variable: "--font-mono", display: "swap" });
const familjenGrotesk = Familjen_Grotesk({ subsets: ["latin"], variable: "--font-prose", display: "swap" });

/**
 * The public origin for absolute OG/Twitter URLs: NEXT_PUBLIC_SITE_URL, else
 * Vercel's production domain when deployed there. A production build with
 * neither gets NO base and no relative OG image — never a localhost URL baked
 * into its <meta> tags. Only `next dev` falls back to localhost.
 */
const configuredSiteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined);
const siteUrl = configuredSiteUrl ?? (process.env.NODE_ENV === "production" ? undefined : "http://localhost:3005");

export const metadata: Metadata = {
  ...(siteUrl ? { metadataBase: new URL(siteUrl) } : {}),
  title: {
    default: "PayKit: open-source TypeScript payments SDK",
    template: "%s · PayKit",
  },
  description:
    "Interactive playground for PayKit: idempotent payments, HMAC-verified webhooks and rule-based fraud detection. Open-source TypeScript SDK (MIT).",
  applicationName: "PayKit",
  authors: [{ name: "Rohan Khiani", url: "https://github.com/ROROK20" }],
  keywords: [
    "fintech",
    "payments",
    "stripe",
    "webhooks",
    "idempotency",
    "fraud detection",
    "typescript",
    "sdk",
  ],
  icons: {
    icon: "/icon.svg",
  },
  openGraph: {
    title: "PayKit: open-source TypeScript payments SDK",
    description:
      "Idempotent payments, HMAC webhooks and fraud detection: the real TypeScript SDK, runnable in your browser",
    // The card's URL is this deployment's, like its image; the repository is
    // linked from the page. With no site URL there is neither.
    ...(siteUrl ? { url: siteUrl } : {}),
    siteName: "PayKit",
    type: "website",
    ...(siteUrl ? { images: [{ url: "/og.png", width: 1200, height: 630, alt: "PayKit SDK playground" }] } : {}),
  },
  twitter: {
    card: "summary_large_image",
    title: "PayKit: open-source TypeScript payments SDK",
    description:
      "Idempotent payments, HMAC webhooks and fraud detection: the real TypeScript SDK, runnable in your browser",
    ...(siteUrl ? { images: ["/og.png"] } : {}),
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${martianMono.variable} ${familjenGrotesk.variable}`}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
