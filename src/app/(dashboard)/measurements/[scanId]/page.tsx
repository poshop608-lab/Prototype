import { notFound } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { MeasurementClient } from "./measurement-client";

export default async function MeasurementPage({
  params,
}: {
  params: { scanId: string };
}) {
  const supabase = createServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const [scanResult, measurementResult, imagesResult] = await Promise.all([
    supabase
      .from("scans")
      .select("*, shoe_model:shoe_models(*), worker:profiles(full_name, email)")
      .eq("id", params.scanId)
      .single(),
    supabase
      .from("measurements")
      .select("*")
      .eq("scan_id", params.scanId)
      .single(),
    supabase
      .from("scan_images")
      .select("*")
      .eq("scan_id", params.scanId),
  ]);

  if (scanResult.error || !scanResult.data) {
    notFound();
  }

  return (
    <MeasurementClient
      scan={scanResult.data}
      measurement={measurementResult.data || null}
      images={imagesResult.data || []}
    />
  );
}
