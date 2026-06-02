import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const scanId = formData.get("scan_id") as string | null;
  const side = (formData.get("side") as string | null) ?? "pair";

  if (!file || !scanId) {
    return NextResponse.json(
      { error: "Missing required fields: file, scan_id" },
      { status: 400 }
    );
  }

  const ext = file.type === "image/webp" ? "webp" : "jpg";
  const path = `${session.user.id}/${scanId}/${side}-${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from("scan-images")
    .upload(path, file, {
      contentType: file.type,
      upsert: false,
    });

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from("scan-images").getPublicUrl(path);

  const { data: imageRecord, error: dbError } = await supabase
    .from("scan_images")
    .insert({
      scan_id: scanId,
      side,
      storage_path: path,
      public_url: publicUrl,
    })
    .select()
    .single();

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  return NextResponse.json(imageRecord, { status: 201 });
}
