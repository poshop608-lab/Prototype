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

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", session.user.id)
    .single();

  const isAdminOrQC =
    profile?.role === "admin" || profile?.role === "qc_inspector";

  const query = supabase
    .from("scans")
    .select(
      `*, shoe_model:shoe_models(name, brand, category), worker:profiles(full_name, email)`
    )
    .order("created_at", { ascending: false })
    .limit(200);

  if (!isAdminOrQC) {
    query.eq("worker_id", session.user.id);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const supabase = createServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { shoe_model_id, size, batch_id } = body;

  if (!shoe_model_id || !size || !batch_id) {
    return NextResponse.json(
      { error: "Missing required fields: shoe_model_id, size, batch_id" },
      { status: 400 }
    );
  }

  const scan_id = `SCN-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;

  const { data, error } = await supabase
    .from("scans")
    .insert({
      scan_id,
      shoe_model_id,
      size: Number(size),
      batch_id,
      worker_id: session.user.id,
      status: "pending",
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}
