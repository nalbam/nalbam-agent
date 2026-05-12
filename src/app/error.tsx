"use client";

import Link from "next/link";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-6 px-6 text-center">
      <p className="text-muted-foreground text-sm font-semibold tracking-widest uppercase">
        Something went wrong
      </p>
      <h1 className="text-foreground text-3xl font-bold md:text-4xl">Unexpected error</h1>
      <p className="text-muted-foreground text-sm">
        {error.digest ? `Reference: ${error.digest}` : "Please try again or contact support."}
      </p>
      <div className="flex gap-3">
        <Button onClick={reset}>Try again</Button>
        <Button variant="outline" asChild>
          <Link href="/">Go home</Link>
        </Button>
      </div>
    </main>
  );
}
