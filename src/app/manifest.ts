import type { MetadataRoute } from "next";

import { clientEnv } from "@/lib/env";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: clientEnv.NEXT_PUBLIC_APP_NAME,
    short_name: clientEnv.NEXT_PUBLIC_APP_NAME,
    description:
      "Multi-tenant, multi-channel, plugin-extensible AI agent on Next.js 16 + Better Auth + DynamoDB + Vercel AI SDK, deployed to AWS Amplify SSR.",
    start_url: "/",
    display: "standalone",
    background_color: "#020617",
    theme_color: "#020617",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
    ],
  };
}
