"use client";

import { Loader2 } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { clientEnv } from "@/lib/env";

interface GoogleButtonProps {
  callbackURL?: string;
}

export function GoogleButton({ callbackURL = "/dashboard" }: GoogleButtonProps) {
  const [submitting, setSubmitting] = useState(false);

  if (!clientEnv.NEXT_PUBLIC_AUTH_GOOGLE_ENABLED) {
    return null;
  }

  const onClick = async () => {
    if (submitting) return;
    setSubmitting(true);
    const result = await authClient.signIn.social({ provider: "google", callbackURL });
    // signIn.social redirects on success; only reach here on error.
    if (result?.error) {
      setSubmitting(false);
      toast.error(result.error.message ?? "Failed to start Google sign-in.");
    }
    // Successful path navigates away — leave `submitting` true so the spinner
    // stays visible during the OAuth bounce.
  };

  return (
    <Button type="button" variant="outline" onClick={onClick} disabled={submitting}>
      {submitting ? (
        <Loader2 className="animate-spin" aria-hidden="true" />
      ) : (
        <Image
          src="/images/google.png"
          alt=""
          width={16}
          height={16}
          aria-hidden="true"
          className="size-4"
        />
      )}
      {submitting ? "Redirecting…" : "Continue with Google"}
    </Button>
  );
}
