"use client";

import { Loader2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { GoogleButton } from "@/app/(auth)/google-button";
import { OrSeparator } from "@/app/(auth)/or-separator";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { clientEnv } from "@/lib/env";
import { safeInternalPath } from "@/lib/safe-redirect";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTarget = safeInternalPath(searchParams.get("redirect"), "/dashboard");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const emailEnabled = clientEnv.NEXT_PUBLIC_AUTH_EMAIL_ENABLED;
  const googleEnabled = clientEnv.NEXT_PUBLIC_AUTH_GOOGLE_ENABLED;

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    const result = await authClient.signIn.email({ email, password });
    if (result.error) {
      setSubmitting(false);
      toast.error(result.error.message ?? "Failed to sign in.");
      return;
    }
    // Keep `submitting` true through the navigation so the spinner stays
    // visible until the destination paints.
    toast.success("Signed in.");
    router.push(redirectTarget);
    router.refresh();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Sign in</CardTitle>
        <CardDescription>
          {emailEnabled
            ? "Welcome back. Use your email to sign in."
            : googleEnabled
              ? "Welcome back. Continue with Google to sign in."
              : "No sign-in methods are enabled."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {googleEnabled ? <GoogleButton callbackURL={redirectTarget} /> : null}
        {googleEnabled && emailEnabled ? <OrSeparator /> : null}
        {emailEnabled ? (
          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={submitting}>
              {submitting ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
            <p className="text-muted-foreground text-center text-sm">
              Don’t have an account?{" "}
              <Link href="/signup" className="text-foreground underline-offset-4 hover:underline">
                Sign up
              </Link>
            </p>
          </form>
        ) : !googleEnabled ? (
          <p className="text-muted-foreground text-sm">
            Configure <code>AUTH_EMAIL_ENABLED</code> or an OAuth provider in your environment to
            enable sign-in.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
