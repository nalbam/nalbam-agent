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

export default function SignupPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTarget = safeInternalPath(searchParams.get("redirect"), "/dashboard");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const emailEnabled = clientEnv.NEXT_PUBLIC_AUTH_EMAIL_ENABLED;
  const googleEnabled = clientEnv.NEXT_PUBLIC_AUTH_GOOGLE_ENABLED;

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    const result = await authClient.signUp.email({
      email,
      password,
      name: name || email.split("@")[0] || "User",
    });
    if (result.error) {
      setSubmitting(false);
      toast.error(result.error.message ?? "Failed to sign up.");
      return;
    }
    toast.success("Account created.");
    router.push(redirectTarget);
    router.refresh();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Create account</CardTitle>
        <CardDescription>
          {emailEnabled
            ? "Sign up with email and password."
            : googleEnabled
              ? "Continue with Google to create your account."
              : "No sign-up methods are enabled."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {googleEnabled ? <GoogleButton callbackURL={redirectTarget} /> : null}
        {googleEnabled && emailEnabled ? <OrSeparator /> : null}
        {emailEnabled ? (
          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                type="text"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Doe"
              />
            </div>
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
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={submitting}>
              {submitting ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {submitting ? "Creating…" : "Create account"}
            </Button>
            <p className="text-muted-foreground text-center text-sm">
              Already have an account?{" "}
              <Link href="/login" className="text-foreground underline-offset-4 hover:underline">
                Sign in
              </Link>
            </p>
          </form>
        ) : !googleEnabled ? (
          <p className="text-muted-foreground text-sm">
            Configure <code>AUTH_EMAIL_ENABLED</code> or an OAuth provider in your environment to
            enable sign-up.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
