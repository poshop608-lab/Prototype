import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest) {
  const supabase = createServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const scanId = formData.get("scan_id") as string | null;
  const angle = formData.get("angle") as string | null;
  const alignmentScore = formData.get("alignment_score") as string | null;

  if (!file || !scanId || !angle) {
    return NextResponse.json(
      { error: "Missing required fields: file, scan_id, angle" },
      { status: 400 }
    );
  }

  const ext = file.type === "image/webp" ? "webp" : "jpg";
  const path = `${session.user.id}/${scanId}/${angle}-${Date.now()}.${ext}`;

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
      angle: angle as any,
      storage_path: path,
      public_url: publicUrl,
      alignment_score: alignmentScore ? parseFloat(alignmentScore) : null,
    })
    .select()
    .single();

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  return NextResponse.json(imageRecord, { status: 201 });
}
