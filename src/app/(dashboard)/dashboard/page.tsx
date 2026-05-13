import { createServerClient } from "@/lib/supabase/server";
import { DashboardClient } from "./dashboard-client";

export default async function DashboardPage() {
  const supabase = createServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const [scansResult, profileResult] = await Promise.all([
    supabase
      .from("scans")
      .select("*, shoe_model:shoe_models(name, brand)")
      .eq("worker_id", session!.user.id)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("profiles")
      .select("*")
      .eq("id", session!.user.id)
      .single(),
  ]);

  const stats = {
    total: scansResult.data?.length || 0,
    completed: scansResult.data?.filter((s) => s.status === "completed").length || 0,
    processing: scansResult.data?.filter((s) => s.status === "processing").length || 0,
    pending: scansResult.data?.filter((s) => s.status === "pending").length || 0,
  };

  return (
    <DashboardClient
      recentScans={scansResult.data || []}
      stats={stats}
      profile={profileResult.data}
    />
  );
}
