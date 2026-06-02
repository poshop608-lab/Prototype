import { createServerClient } from "@/lib/supabase/server";
import { ScansClient } from "./scans-client";

export const dynamic = "force-dynamic";

export default async function ScansPage() {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profileData } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  const role = (profileData as { role?: string } | null)?.role;
  const isAdminOrQC = role === "admin" || role === "qc_inspector";

  const baseQuery = supabase
    .from("scans")
    .select("*, worker:profiles(full_name, email)")
    .order("created_at", { ascending: false })
    .limit(100);

  const { data: scans } = isAdminOrQC
    ? await baseQuery
    : await baseQuery.eq("worker_id", user.id);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <ScansClient scans={(scans as any[]) || []} />;
}
