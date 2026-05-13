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

  const scans = (scansResult.data || []) as any[];
  const profile = profileResult.data as any;

  const stats = {
    total: scans.length,
    completed: scans.filter((s: any) => s.status === "completed").length,
    processing: scans.filter((s: any) => s.status === "processing").length,
    pending: scans.filter((s: any) => s.status === "pending").length,
  };

  return (
    <DashboardClient
      recentScans={scans}
      stats={stats}
      profile={profile}
    />
  );
}
