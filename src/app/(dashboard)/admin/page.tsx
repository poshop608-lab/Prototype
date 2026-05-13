import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { AdminClient } from "./admin-client";
import type { UserRole } from "@/types/database";

export default async function AdminPage() {
  const supabase = createServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const { data: profileData } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", session!.user.id)
    .single();

  const profile = profileData as { role: UserRole } | null;

  if (profile?.role !== "admin") {
    redirect("/dashboard");
  }

  const [scansResult, usersResult] = await Promise.all([
    supabase
      .from("scans")
      .select(`
        *,
        shoe_model:shoe_models(name, brand, category),
        worker:profiles(full_name, email)
      `)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("profiles")
      .select("*")
      .order("created_at", { ascending: false }),
  ]);

  const scans = (scansResult.data || []) as any[];
  const users = (usersResult.data || []) as any[];

  const stats = {
    total: scans.length,
    completed: scans.filter((s) => s.status === "completed").length,
    processing: scans.filter((s) => s.status === "processing").length,
    failed: scans.filter((s) => s.status === "failed").length,
    workers: users.filter((u) => u.role === "worker").length,
    inspectors: users.filter((u) => u.role === "qc_inspector").length,
  };

  return <AdminClient scans={scans} users={users} stats={stats} />;
}
