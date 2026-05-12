import Link from "next/link";

import { SignOutButton } from "@/components/sign-out-button";
import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/auth/session";

const stacks = [
  "Node.js 22",
  "Next.js 16",
  "Better Auth",
  "React 19",
  "TypeScript",
  "AWS DynamoDB (Single Table)",
  "Tailwind CSS",
  "shadcn/ui",
  "pnpm",
];

const quickStart = [
  "cp .env.example .env.local",
  "docker compose up -d",
  "pnpm install",
  "pnpm db:init",
  "pnpm dev",
];

export default async function Home() {
  const session = await getSession();
  const user = session?.user;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col justify-center gap-10 px-6 py-12 md:px-12">
      <section className="border-border/60 bg-card/70 rounded-3xl border p-8 shadow-2xl shadow-cyan-500/10 backdrop-blur md:p-12">
        <p className="border-primary/30 bg-primary/10 text-primary mb-4 inline-flex rounded-full border px-3 py-1 text-xs font-semibold tracking-widest uppercase">
          Production-ready starter
        </p>
        <h1 className="text-foreground text-3xl leading-tight font-bold md:text-5xl">
          Launch your next project instantly
        </h1>
        <p className="text-muted-foreground mt-4 max-w-3xl text-base leading-7 md:text-lg">
          This template ships with Better Auth on DynamoDB single-table, Tailwind v4 + shadcn/ui, a
          Vitest harness, and an Amplify deploy guide so you can focus on building product features
          from day one.
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
                <Link href="/dashboard">Dashboard</Link>
              </Button>
              <SignOutButton />
            </div>
          </div>
        ) : (
          <div className="mt-6 flex flex-wrap gap-3">
            <Button asChild>
              <Link href="/signup?redirect=/">Get started</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/login?redirect=/">Sign in</Link>
            </Button>
            <Button asChild variant="secondary">
              <Link href="/dashboard">Dashboard</Link>
            </Button>
          </div>
        )}
        <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {stacks.map((stack) => (
            <div
              key={stack}
              className="border-border bg-background/60 text-foreground rounded-xl border px-4 py-3 text-sm font-medium"
            >
              {stack}
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        <article className="border-border/60 bg-card/60 rounded-2xl border p-6">
          <h2 className="text-foreground text-lg font-semibold">Quick start</h2>
          <ol className="text-muted-foreground mt-4 space-y-2 text-sm">
            {quickStart.map((step, index) => (
              <li key={step} className="flex gap-3">
                <span className="text-primary">{index + 1}.</span>
                <code className="text-foreground">{step}</code>
              </li>
            ))}
          </ol>
        </article>

        <article className="border-border/60 bg-card/60 rounded-2xl border p-6">
          <h2 className="text-foreground text-lg font-semibold">Included foundations</h2>
          <ul className="text-muted-foreground mt-4 space-y-2 text-sm">
            <li>
              • Better Auth API route at <code>/api/auth/[...all]</code> wired to DynamoDB.
            </li>
            <li>
              • Single-table key utilities and a typed adapter at <code>src/lib/auth/</code>.
            </li>
            <li>• Demo flows for sign-up, sign-in, and protected routes ready to extend.</li>
          </ul>
        </article>
      </section>
    </main>
  );
}
