import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { imageBase64 } = await req.json();

  if (!imageBase64) {
    return NextResponse.json({ error: "imageBase64 required" }, { status: 400 });
  }

  const apiKey = process.env.ROBOFLOW_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ROBOFLOW_API_KEY not configured" }, { status: 500 });
  }

  // confidence=10 catches shoes even with low contrast / dark on dark
  // overlap=80 allows side-by-side detections that share bounding box edges
  const url = `https://detect.roboflow.com/shoe-segmentation-0kxvd/1?api_key=${apiKey}&confidence=10&overlap=80`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: imageBase64,
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: text }, { status: res.status });
  }

  const data = await res.json();
  return NextResponse.json(data);
}
