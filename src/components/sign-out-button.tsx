"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const onClick = async () => {
    if (submitting) return;
    setSubmitting(true);
    const result = await authClient.signOut();
    setSubmitting(false);
    if (result.error) {
      toast.error(result.error.message ?? "Failed to sign out.");
      return;
    }
    toast.success("Signed out.");
    router.replace("/");
    router.refresh();
  };

  return (
    <Button variant="outline" onClick={onClick} disabled={submitting}>
      {submitting ? "Signing out…" : "Sign out"}
    </Button>
  );
}
