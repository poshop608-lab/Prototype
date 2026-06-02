import { notFound } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { ScanDetailClient } from "./measurement-client";

export const dynamic = "force-dynamic";

export default async function ScanDetailPage({
  params,
}: {
  params: Promise<{ scanId: string }>;
}) {
  const { scanId } = await params;
  const supabase = await createServerClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) notFound();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;

  const [scanResult, imageResult] = await Promise.all([
    db.from("scans").select("*, worker:profiles(full_name, email)").eq("id", scanId).single(),
    db.from("scan_images").select("*").eq("scan_id", scanId).eq("side", "pair").maybeSingle(),
  ]);

  if (scanResult.error || !scanResult.data) notFound();

  return (
    <ScanDetailClient
      scan={scanResult.data}
      image={imageResult.data || null}
    />
  );
}
