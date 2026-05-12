import type { MetadataRoute } from "next";

import { clientEnv } from "@/lib/env";

const baseUrl = (): string => {
  if (clientEnv.NEXT_PUBLIC_BETTER_AUTH_URL) {
    return clientEnv.NEXT_PUBLIC_BETTER_AUTH_URL;
  }
  return "http://localhost:3000";
};

export default function sitemap(): MetadataRoute.Sitemap {
  const base = baseUrl();
  const now = new Date();
  return [
    { url: base, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/login`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${base}/signup`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
  ];
}
