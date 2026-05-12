import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";

import { Toaster } from "@/components/ui/sonner";
import { clientEnv } from "@/lib/env";

import "./globals.css";

const pretendard = localFont({
  src: "./fonts/PretendardVariable.woff2",
  display: "swap",
  variable: "--font-pretendard",
  weight: "45 920",
});

const metadataBaseUrl = clientEnv.NEXT_PUBLIC_BETTER_AUTH_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(metadataBaseUrl),
  title: {
    default: clientEnv.NEXT_PUBLIC_APP_NAME,
    template: `%s · ${clientEnv.NEXT_PUBLIC_APP_NAME}`,
  },
  description:
    "Node.js 22 + Next.js 16 + Better Auth + React 19 + TypeScript + DynamoDB + Tailwind CSS starter",
  applicationName: clientEnv.NEXT_PUBLIC_APP_NAME,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#020617" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning silences mismatches caused by browser
    // extensions (e.g., translation toolbars, password managers, accessibility
    // extensions) that inject attributes onto <html> before React hydrates.
    // It does NOT silence mismatches inside the React tree itself.
    <html lang="ko" className={pretendard.variable} suppressHydrationWarning>
      <body>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
