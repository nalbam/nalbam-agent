import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { listSlackApps } from "@/lib/slack/app-metadata";

export const dynamic = "force-dynamic";

const formatTime = (epoch: number): string => {
  if (!epoch) return "—";
  try {
    return new Date(epoch * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z";
  } catch {
    return "—";
  }
};

export default async function SlackAppsPage() {
  const apps = await listSlackApps();
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Slack apps</h1>
          <p className="text-muted-foreground text-sm">
            Per-tenant Slack apps wired into this deployment. Secrets live in AWS SSM
            Parameter Store; metadata and ACL / persona overrides live in DynamoDB.
          </p>
        </div>
        <Button asChild>
          <Link href="/slack/new">Register app</Link>
        </Button>
      </header>

      {apps.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-muted-foreground">
              No apps registered yet. Click <strong>Register app</strong> to add the first one.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-3">
          {apps.map((app) => (
            <li key={app.apiAppId}>
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between gap-4">
                    <Link
                      href={`/slack/${app.apiAppId}`}
                      className="hover:underline"
                    >
                      {app.displayName ?? app.teamName ?? app.apiAppId}
                    </Link>
                    <code className="text-muted-foreground font-mono text-xs">
                      {app.apiAppId}
                    </code>
                  </CardTitle>
                  <CardDescription className="space-x-3">
                    {app.teamName ? <span>team: {app.teamName}</span> : null}
                    {app.botUserName ? <span>bot: @{app.botUserName}</span> : null}
                    {app.teamId ? (
                      <span className="font-mono text-xs">{app.teamId}</span>
                    ) : null}
                  </CardDescription>
                </CardHeader>
                <CardContent className="text-muted-foreground space-y-1 text-sm">
                  <div>first seen: {formatTime(app.firstSeenAt)}</div>
                  <div>last seen: {formatTime(app.lastSeenAt)}</div>
                  {app.allowedChannelIds !== undefined ? (
                    <div>
                      channel allowlist:{" "}
                      <code>
                        {app.allowedChannelIds.length === 0
                          ? "[] (allow all)"
                          : app.allowedChannelIds.join(", ")}
                      </code>
                    </div>
                  ) : null}
                  {app.allowedUserIds !== undefined ? (
                    <div>
                      user allowlist:{" "}
                      <code>
                        {app.allowedUserIds.length === 0
                          ? "[] (allow all)"
                          : app.allowedUserIds.join(", ")}
                      </code>
                    </div>
                  ) : null}
                  {app.personaMessage !== undefined ? (
                    <div>persona override: {app.personaMessage || "(empty — no persona)"}</div>
                  ) : null}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
