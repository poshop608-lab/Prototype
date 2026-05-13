import { createServerClient } from "@/lib/supabase/server";
import { ScanSetup } from "./scan-setup";

export default async function ScanPage() {
  const supabase = createServerClient();
  const { data: models } = await supabase
    .from("shoe_models")
    .select("*")
    .order("brand");

  return <ScanSetup shoeModels={models || []} />;
}
