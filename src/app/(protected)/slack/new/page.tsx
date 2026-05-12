import Link from "next/link";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { registerSlackAppAction } from "../actions";

export const dynamic = "force-dynamic";

async function submit(formData: FormData) {
  "use server";
  const result = await registerSlackAppAction(formData);
  redirect(`/slack/${result.apiAppId}`);
}

export default function RegisterSlackAppPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">Register Slack app</h1>
        <p className="text-muted-foreground text-sm">
          The signing secret and bot token are stored as SecureString parameters in AWS
          SSM. The bot token is verified with <code>auth.test</code> before anything is
          persisted, and the returned <code>team_id</code> / <code>user_id</code> /{" "}
          <code>team_name</code> populate the metadata row automatically.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Credentials</CardTitle>
          <CardDescription>
            Find these on your Slack app dashboard under <em>Basic Information</em> and{" "}
            <em>OAuth &amp; Permissions</em>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="apiAppId">App ID</Label>
              <Input
                id="apiAppId"
                name="apiAppId"
                placeholder="A0XXXXXXXXX"
                pattern="^A[0-9A-Z]+$"
                required
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="signingSecret">Signing secret</Label>
              <Input
                id="signingSecret"
                name="signingSecret"
                type="password"
                required
                autoComplete="off"
                minLength={16}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="botToken">Bot user token (xoxb-…)</Label>
              <Input
                id="botToken"
                name="botToken"
                type="password"
                required
                autoComplete="off"
                pattern="^(xoxb|xoxp)-.+"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="displayName">Display name (optional)</Label>
              <Input
                id="displayName"
                name="displayName"
                placeholder="Production – Acme"
                autoComplete="off"
              />
            </div>
            <div className="flex items-center gap-3">
              <Button type="submit">Register</Button>
              <Button asChild variant="outline">
                <Link href="/slack">Cancel</Link>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
