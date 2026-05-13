import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

export async function GET(req: NextRequest) {
  const supabase = createServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const scanId = searchParams.get("scan_id");

  let query = supabase
    .from("measurements")
    .select(
      `*, scan:scans(scan_id, size, status, batch_id, created_at, shoe_model:shoe_models(name, brand))`
    )
    .order("created_at", { ascending: false })
    .limit(100);

  if (scanId) {
    query = query.eq("scan_id", scanId) as any;
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}
