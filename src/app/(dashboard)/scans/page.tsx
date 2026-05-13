import { createServerClient } from "@/lib/supabase/server";
import { ScansClient } from "./scans-client";

export default async function ScansPage() {
  const supabase = createServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", session!.user.id)
    .single();

  const isAdminOrQC = profile?.role === "admin" || profile?.role === "qc_inspector";

  const query = supabase
    .from("scans")
    .select(`
      *,
      shoe_model:shoe_models(name, brand, category),
      worker:profiles(full_name, email)
    `)
    .order("created_at", { ascending: false })
    .limit(100);

  if (!isAdminOrQC) {
    query.eq("worker_id", session!.user.id);
  }

  const { data: scans } = await query;

  return <ScansClient scans={scans || []} />;
}
