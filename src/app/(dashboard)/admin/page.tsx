import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { AdminClient } from "./admin-client";

export default async function AdminPage() {
  const supabase = createServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", session!.user.id)
    .single();

  if (profile?.role !== "admin") {
    redirect("/dashboard");
  }

  const [scansResult, usersResult, statsResult] = await Promise.all([
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
    supabase
      .from("scans")
      .select("status", { count: "exact" }),
  ]);

  const scans = scansResult.data || [];
  const users = usersResult.data || [];

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
