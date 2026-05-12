import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }
  return <>{children}</>;
}
