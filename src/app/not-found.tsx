import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-6 px-6 text-center">
      <p className="text-muted-foreground text-sm font-semibold tracking-widest uppercase">404</p>
      <h1 className="text-foreground text-3xl font-bold md:text-4xl">Page not found</h1>
      <p className="text-muted-foreground text-sm">
        The page you’re looking for doesn’t exist or has been moved.
      </p>
      <Button asChild>
        <Link href="/">Go home</Link>
      </Button>
    </main>
  );
}
