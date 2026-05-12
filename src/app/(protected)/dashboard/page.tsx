import Link from "next/link";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SignOutButton } from "@/components/sign-out-button";
import { getSession } from "@/lib/auth/session";

export const metadata = {
  title: "Dashboard",
};

export default async function DashboardPage() {
  const session = await getSession();
  const user = session?.user;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-6 py-12">
      <Link
        href="/"
        className="text-muted-foreground hover:text-foreground text-sm transition self-start"
      >
        ← Home
      </Link>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-muted-foreground text-xs font-semibold tracking-widest uppercase">
            Protected route
          </p>
          <h1 className="text-foreground text-3xl font-bold">Dashboard</h1>
        </div>
        <SignOutButton />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Session</CardTitle>
          <CardDescription>
            This page is rendered on the server. The session is fetched via Better Auth.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Field label="ID" value={user?.id ?? "—"} />
          <Field label="Email" value={user?.email ?? "—"} />
          <Field label="Name" value={user?.name ?? "—"} />
        </CardContent>
      </Card>
    </main>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3">
      <span className="text-muted-foreground">{label}</span>
      <code className="text-foreground break-all">{value}</code>
    </div>
  );
}
