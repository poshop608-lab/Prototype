import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { AdminClient } from "./admin-client";
import type { UserRole } from "@/types/database";

export default async function AdminPage() {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profileData } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  const profile = profileData as { role: UserRole } | null;
  if (profile?.role !== "admin") redirect("/dashboard");

  const [scansResult, usersResult] = await Promise.all([
    supabase
      .from("scans")
      .select("*, worker:profiles(full_name, email)")
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("profiles")
      .select("*")
      .order("created_at", { ascending: false }),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scans = (scansResult.data || []) as any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const users = (usersResult.data || []) as any[];

  const stats = {
    total: scans.length,
    passed: scans.filter((s) => s.passed === true).length,
    rejected: scans.filter((s) => s.passed === false).length,
    workers: users.filter((u) => u.role === "worker").length,
  };

  return <AdminClient scans={scans} users={users} stats={stats} />;
}
