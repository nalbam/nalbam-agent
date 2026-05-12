import Link from "next/link";

import { SignOutButton } from "@/components/sign-out-button";
import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/auth/session";

const capabilities = [
  "Multi-tenant Slack apps",
  "Vercel AI SDK agent loop",
  "OpenAI + Bedrock providers",
  "DynamoDB single-table",
  "AWS SSM SecureString secrets",
  "Better Auth operator UI",
  "next/server after() handoff",
  "11 built-in agent tools",
];

const tools = [
  "fetch_webpage",
  "search_web / search_images",
  "read_attached_images / document",
  "fetch_user_profile",
  "fetch_thread_history",
  "generate_image · attach_image_from_url",
  "get_current_time",
];

export default async function Home() {
  const session = await getSession();
  const user = session?.user;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col justify-center gap-10 px-6 py-12 md:px-12">
      <section className="border-border/60 bg-card/70 rounded-3xl border p-8 shadow-2xl shadow-cyan-500/10 backdrop-blur md:p-12">
        <p className="border-primary/30 bg-primary/10 text-primary mb-4 inline-flex rounded-full border px-3 py-1 text-xs font-semibold tracking-widest uppercase">
          Slack AI agent
        </p>
        <h1 className="text-foreground text-3xl leading-tight font-bold md:text-5xl">
          Multi-tenant Slack bot, one Amplify deployment
        </h1>
        <p className="text-muted-foreground mt-4 max-w-3xl text-base leading-7 md:text-lg">
          A multi-tenant Slack AI agent built on Next.js 16 + Vercel AI SDK + DynamoDB
          single-table, deployed to AWS Amplify SSR. Per-app secrets live in AWS SSM
          SecureString; ACL and persona overrides live in DynamoDB. Operators register
          and manage apps from the web UI under <code>/slack</code> or via{" "}
          <code>pnpm slack-apps</code>.
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
              <Button asChild>
                <Link href="/slack">Manage Slack apps</Link>
              </Button>
              <SignOutButton />
            </div>
          </div>
        ) : (
          <div className="mt-6 flex flex-wrap gap-3">
            <Button asChild>
              <Link href="/signup?redirect=/slack">Create operator account</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/login?redirect=/slack">Sign in</Link>
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
          <h2 className="text-foreground text-lg font-semibold">Built-in agent tools</h2>
          <ul className="text-muted-foreground mt-4 space-y-2 text-sm">
            {tools.map((tool) => (
              <li key={tool} className="flex gap-3">
                <span className="text-primary">·</span>
                <code className="text-foreground">{tool}</code>
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
                href="https://github.com/nalbam/nalbam-agent/blob/main/docs/slack-bot.md"
                className="text-foreground hover:underline"
              >
                docs/slack-bot.md
              </Link>{" "}
              — architecture, Slack-side setup, web UI + CLI workflow.
            </li>
            <li>
              ·{" "}
              <Link
                href="https://github.com/nalbam/nalbam-agent/blob/main/docs/amplify-deploy.md"
                className="text-foreground hover:underline"
              >
                docs/amplify-deploy.md
              </Link>{" "}
              — IAM (DynamoDB + SSM + Bedrock) and env-var reference.
            </li>
            <li>
              ·{" "}
              <Link
                href="https://github.com/nalbam/nalbam-agent/blob/main/docs/runbook.md"
                className="text-foreground hover:underline"
              >
                docs/runbook.md
              </Link>{" "}
              — registering apps, rotating secrets, after() verification, incident response.
            </li>
          </ul>
        </article>
      </section>
    </main>
  );
}
