import { cache } from "react";
import { headers as nextHeaders } from "next/headers";

import { getAuth } from "@/lib/auth";

// `cache()` dedupes per-request. layout + page both calling getSession()
// only hit the KV / DB once.
export const getSession = cache(async () => {
  const auth = getAuth();
  const requestHeaders = await nextHeaders();
  return auth.api.getSession({ headers: requestHeaders });
});
