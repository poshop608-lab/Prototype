import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { imageBase64 } = await req.json();
  if (!imageBase64) return NextResponse.json({ error: "imageBase64 required" }, { status: 400 });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 });

  const prompt = `You are a shoe detection system for a factory QC tool.
This image shows two shoes placed side by side on a surface.
Detect EXACTLY the two shoes and return their bounding boxes.

Return ONLY valid JSON, no markdown, no explanation:
{"shoes":[{"label":"left","box":[y1,x1,y2,x2]},{"label":"right","box":[y1,x1,y2,x2]}]}

Where box coordinates are normalized 0-1000 (y1=top, x1=left, y2=bottom, x2=right).
Sort by x position: leftmost shoe first (label="left"), rightmost shoe second (label="right").
Include ONLY the shoe object, not the surface/table/background.
If you cannot find two shoes, return {"shoes":[]}.`;

  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: "image/jpeg", data: imageBase64 } }
      ]
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 256 }
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: text }, { status: res.status });
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  try {
    // Strip markdown code blocks if present
    const clean = text.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(clean);
    return NextResponse.json(parsed);
  } catch {
    return NextResponse.json({ error: "Failed to parse Gemini response", raw: text }, { status: 500 });
  }
}
