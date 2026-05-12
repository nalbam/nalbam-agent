import Link from "next/link";
import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { getSlackApp } from "@/lib/slack/app-metadata";

import {
  deleteSlackAppAction,
  updateSlackAppAllowlistAction,
  updateSlackAppDisplayNameAction,
  updateSlackAppPersonaAction,
} from "../actions";

export const dynamic = "force-dynamic";

const renderList = (values: string[] | undefined): string => {
  if (values === undefined) return "(env fallback)";
  if (values.length === 0) return "[] (explicit allow-all)";
  return values.join(", ");
};

interface PageProps {
  params: Promise<{ appId: string }>;
}

export default async function SlackAppDetailPage({ params }: PageProps) {
  const { appId } = await params;
  const app = await getSlackApp(appId);
  if (!app) notFound();

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">
            {app.displayName ?? app.teamName ?? app.apiAppId}
          </h1>
          <p className="text-muted-foreground space-x-2 text-sm">
            <code className="font-mono">{app.apiAppId}</code>
            {app.teamName ? <span>· {app.teamName}</span> : null}
            {app.botUserName ? <span>· @{app.botUserName}</span> : null}
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/slack">← Back</Link>
        </Button>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Display name</CardTitle>
          <CardDescription>
            Operator-set label. Takes precedence over the workspace name in the app list.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={updateSlackAppDisplayNameAction} className="flex items-end gap-2">
            <input type="hidden" name="apiAppId" value={app.apiAppId} />
            <input type="hidden" name="action" value="set" />
            <div className="flex-1 space-y-2">
              <Label htmlFor="displayName">Display name</Label>
              <Input
                id="displayName"
                name="value"
                defaultValue={app.displayName ?? ""}
                placeholder={app.teamName ?? "Production – Acme"}
              />
            </div>
            <Button type="submit">Save</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Channel allowlist</CardTitle>
          <CardDescription>
            Empty list = explicit allow-all (overrides env). Removing the override falls back
            to <code>ALLOWED_CHANNEL_IDS</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form action={updateSlackAppAllowlistAction} className="space-y-2">
            <input type="hidden" name="apiAppId" value={app.apiAppId} />
            <input type="hidden" name="attr" value="allowedChannelIds" />
            <input type="hidden" name="action" value="set" />
            <Label htmlFor="channels">Channel IDs (comma-separated)</Label>
            <Input
              id="channels"
              name="values"
              defaultValue={(app.allowedChannelIds ?? []).join(",")}
              placeholder="C1234567890,C0987654321"
            />
            <p className="text-muted-foreground text-xs">
              Currently: <code>{renderList(app.allowedChannelIds)}</code>
            </p>
            <div className="flex gap-2">
              <Button type="submit" size="sm">
                Save override
              </Button>
            </div>
          </form>
          <form action={updateSlackAppAllowlistAction}>
            <input type="hidden" name="apiAppId" value={app.apiAppId} />
            <input type="hidden" name="attr" value="allowedChannelIds" />
            <input type="hidden" name="action" value="unset" />
            <Button type="submit" variant="outline" size="sm">
              Remove override (use env)
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>User allowlist</CardTitle>
          <CardDescription>
            Same semantics as the channel list, applied in channels and DMs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form action={updateSlackAppAllowlistAction} className="space-y-2">
            <input type="hidden" name="apiAppId" value={app.apiAppId} />
            <input type="hidden" name="attr" value="allowedUserIds" />
            <input type="hidden" name="action" value="set" />
            <Label htmlFor="users">User IDs (comma-separated)</Label>
            <Input
              id="users"
              name="values"
              defaultValue={(app.allowedUserIds ?? []).join(",")}
              placeholder="U1234567890,U0987654321"
            />
            <p className="text-muted-foreground text-xs">
              Currently: <code>{renderList(app.allowedUserIds)}</code>
            </p>
            <Button type="submit" size="sm">
              Save override
            </Button>
          </form>
          <form action={updateSlackAppAllowlistAction}>
            <input type="hidden" name="apiAppId" value={app.apiAppId} />
            <input type="hidden" name="attr" value="allowedUserIds" />
            <input type="hidden" name="action" value="unset" />
            <Button type="submit" variant="outline" size="sm">
              Remove override (use env)
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Persona</CardTitle>
          <CardDescription>
            Per-app answer style. Empty string is meaningful — it means &quot;no persona&quot; and
            overrides <code>PERSONA_MESSAGE</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form action={updateSlackAppPersonaAction} className="space-y-2">
            <input type="hidden" name="apiAppId" value={app.apiAppId} />
            <input type="hidden" name="action" value="set" />
            <Label htmlFor="persona">Persona</Label>
            <Input
              id="persona"
              name="value"
              defaultValue={app.personaMessage ?? ""}
              placeholder="자연스러운 한국어로 핵심부터 답한다"
            />
            <p className="text-muted-foreground text-xs">
              Currently:{" "}
              <code>
                {app.personaMessage === undefined
                  ? "(env fallback)"
                  : app.personaMessage === ""
                    ? "\"\" (no persona)"
                    : app.personaMessage}
              </code>
            </p>
            <Button type="submit" size="sm">
              Save override
            </Button>
          </form>
          <form action={updateSlackAppPersonaAction}>
            <input type="hidden" name="apiAppId" value={app.apiAppId} />
            <input type="hidden" name="action" value="unset" />
            <Button type="submit" variant="outline" size="sm">
              Remove override (use env)
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-destructive">Danger zone</CardTitle>
          <CardDescription>
            Removes the app metadata row from DynamoDB AND deletes both SSM
            SecureString parameters. Type the App ID to confirm.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={deleteSlackAppAction} className="flex items-end gap-2">
            <input type="hidden" name="apiAppId" value={app.apiAppId} />
            <div className="flex-1 space-y-2">
              <Label htmlFor="confirm">Confirm App ID</Label>
              <Input id="confirm" name="confirm" placeholder={app.apiAppId} required />
            </div>
            <Button type="submit" variant="destructive">
              Delete app
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
