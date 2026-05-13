import Link from "next/link";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isOperatorAllowed } from "@/lib/auth/operator";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function SlackLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session?.user) {
    redirect("/login?redirect=/slack");
  }
  const check = isOperatorAllowed(session.user);
  if (!check.allowed) {
    return (
      <main className="mx-auto max-w-md p-12">
        <Card>
          <CardHeader>
            <CardTitle>Operator access required</CardTitle>
            <CardDescription>
              Your account ({session.user.email ?? "unknown"}) is not on the operator allowlist. Ask
              an administrator to add it to <code>OPERATOR_ALLOWED_EMAILS</code>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/">← Home</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }
  return <>{children}</>;
}
