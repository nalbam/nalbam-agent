import Link from "next/link";

import { SignOutButton } from "@/components/sign-out-button";
import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/auth/session";

const capabilities = [
  "Multi-tenant — one deployment, many tenants",
  "Multi-channel via plugin adapters",
  "Channel-agnostic agent core",
  "Capability-bound tools",
  "Pluggable LLM providers",
  "Pluggable storage & memory",
  "Per-channel credential isolation",
  "next/server after() handoff",
];

const channels = [
  "Slack — first channel (in progress)",
  "Web UI (SSE) — planned",
  "HTTP API (token) — planned",
  "Telegram (connection mode) — planned",
];

export default async function Home() {
  const session = await getSession();
  const user = session?.user;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col justify-center gap-10 px-6 py-12 md:px-12">
      <section className="border-border/60 bg-card/70 rounded-3xl border p-8 shadow-2xl shadow-cyan-500/10 backdrop-blur md:p-12">
        <p className="border-primary/30 bg-primary/10 text-primary mb-4 inline-flex rounded-full border px-3 py-1 text-xs font-semibold tracking-widest uppercase">
          Multi-channel AI agent
        </p>
        <h1 className="text-foreground text-3xl leading-tight font-bold md:text-5xl">
          Multi-tenant, multi-channel, plugin-extensible AI agent
        </h1>
        <p className="text-muted-foreground mt-4 max-w-3xl text-base leading-7 md:text-lg">
          A multi-tenant AI agent on Next.js 16 + Vercel AI SDK + DynamoDB, deployed to AWS Amplify
          SSR. Channels plug in as adapters: a channel-agnostic core handles every conversation, so
          Slack, Web, HTTP API, and Telegram all funnel into the same pipeline. Slack is the first
          channel; the rest follow. See the architecture and roadmap docs.
        </p>
        {user ? (
          <div className="border-border/60 bg-background/60 mt-6 flex flex-wrap items-center gap-4 rounded-2xl border px-5 py-4">
            <div className="min-w-0 flex-1">
              <p className="text-muted-foreground text-xs font-semibold tracking-widest uppercase">
                Signed in
              </p>
              <p className="text-foreground mt-1 truncate text-base font-medium">
                {user.name ?? user.email}
              </p>
              {user.name ? (
                <p className="text-muted-foreground truncate text-sm">{user.email}</p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <SignOutButton />
            </div>
          </div>
        ) : (
          <div className="mt-6 flex flex-wrap gap-3">
            <Button asChild>
              <Link href="/signup">Create account</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/login">Sign in</Link>
            </Button>
          </div>
        )}
        <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {capabilities.map((cap) => (
            <div
              key={cap}
              className="border-border bg-background/60 text-foreground rounded-xl border px-4 py-3 text-sm font-medium"
            >
              {cap}
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        <article className="border-border/60 bg-card/60 rounded-2xl border p-6">
          <h2 className="text-foreground text-lg font-semibold">Channels</h2>
          <ul className="text-muted-foreground mt-4 space-y-2 text-sm">
            {channels.map((channel) => (
              <li key={channel} className="flex gap-3">
                <span className="text-primary">·</span>
                <span className="text-foreground">{channel}</span>
              </li>
            ))}
          </ul>
        </article>

        <article className="border-border/60 bg-card/60 rounded-2xl border p-6">
          <h2 className="text-foreground text-lg font-semibold">Read the docs</h2>
          <ul className="text-muted-foreground mt-4 space-y-2 text-sm">
            <li>
              ·{" "}
              <Link
                href="https://github.com/nalbam/nalbam-agent/blob/main/docs/architecture.md"
                className="text-foreground hover:underline"
              >
                docs/architecture.md
              </Link>{" "}
              — target design: adapters, normalized schema, plugin protocol.
            </li>
            <li>
              ·{" "}
              <Link
                href="https://github.com/nalbam/nalbam-agent/blob/main/docs/roadmap.md"
                className="text-foreground hover:underline"
              >
                docs/roadmap.md
              </Link>{" "}
              — implementation goals per component and build order.
            </li>
          </ul>
        </article>
      </section>
    </main>
  );
}
