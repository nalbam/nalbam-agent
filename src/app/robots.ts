import type { MetadataRoute } from "next";

import { clientEnv } from "@/lib/env";

export default function robots(): MetadataRoute.Robots {
  const base = clientEnv.NEXT_PUBLIC_BETTER_AUTH_URL ?? "http://localhost:3000";
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/dashboard"],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
