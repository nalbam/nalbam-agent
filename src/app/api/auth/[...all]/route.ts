import { toNextJsHandler } from "better-auth/next-js";

import { getAuth } from "@/lib/auth";

// Lazy: getAuth() is invoked per request so the build does not require
// BETTER_AUTH_SECRET to be set at import time.
const handler = (request: Request) => getAuth().handler(request);

export const { GET, POST, PUT, PATCH, DELETE } = toNextJsHandler(handler);
