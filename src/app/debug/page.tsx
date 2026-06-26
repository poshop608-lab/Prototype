"use client";

// CV Debug page — NOT for production use.
// Shows each pipeline stage visually so we can diagnose detection failures.
// Access: /debug (no auth required)

import { useRef, useState, useCallback, useEffect } from "react";
import { useCamera } from "@/hooks/use-camera";
import { extractFrame, frameToGrayscale } from "@/lib/cv/frame";

function otsuThreshold(gray: Uint8Array): number {
  const hist = new Int32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sumB = 0, wB = 0, sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let maxVar = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > maxVar) { maxVar = v; threshold = t; }
  }
  return threshold;
}

function blur3(gray: Uint8Array, w: number, h: number): Uint8Array {
  const k = [1,2,1,2,4,2,1,2,1];
  const out = new Uint8Array(gray.length);
  for (let y = 1; y < h-1; y++)
    for (let x = 1; x < w-1; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          s += gray[(y+dy)*w+(x+dx)] * k[(dy+1)*3+(dx+1)];
      out[y*w+x] = s >> 4;
    }
  for (let x = 0; x < w; x++) { out[x]=gray[x]; out[(h-1)*w+x]=gray[(h-1)*w+x]; }
  for (let y = 0; y < h; y++) { out[y*w]=gray[y*w]; out[y*w+w-1]=gray[y*w+w-1]; }
  return out;
}

function morphOp(src: Uint8Array, w: number, h: number, r: number, dilate: boolean): Uint8Array {
  const out = new Uint8Array(src.length);
  const target = dilate ? 1 : 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let hit = !dilate;
      outer: for (let dy = -r; dy <= r; dy++) {
        const ny = y+dy; if (ny<0||ny>=h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const nx = x+dx; if (nx<0||nx>=w) continue;
          if (src[ny*w+nx]===target) { hit=dilate; break outer; }
        }
      }
      out[y*w+x] = hit ? 1 : 0;
    }
  return out;
}

interface BlobInfo {
  minX: number; maxX: number; minY: number; maxY: number; area: number;
}

function findBlobs(bin: Uint8Array, w: number, h: number): BlobInfo[] {
  const labels = new Int32Array(w*h);
  const parent: number[] = [];
  function find(x: number): number {
    while (parent[x]!==x) { parent[x]=parent[parent[x]]; x=parent[x]; }
    return x;
  }
  let next = 1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const idx = y*w+x;
      if (!bin[idx]) continue;
      const up = y>0?labels[(y-1)*w+x]:0;
      const lf = x>0?labels[idx-1]:0;
      if (!up&&!lf) { labels[idx]=next; parent.push(next); next++; }
      else if (up&&!lf) labels[idx]=up;
      else if (!up&&lf) labels[idx]=lf;
      else { labels[idx]=up; const a=find(up),b=find(lf); if(a!==b) parent[b]=a; }
    }
  const map = new Map<number,BlobInfo>();
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
    const lbl = labels[y*w+x]; if (!lbl) continue;
    const root = find(lbl);
    let c = map.get(root);
    if (!c) { c={minX:x,maxX:x,minY:y,maxY:y,area:0}; map.set(root,c); }
    if (x<c.minX) c.minX=x; if (x>c.maxX) c.maxX=x;
    if (y<c.minY) c.minY=y; if (y>c.maxY) c.maxY=y;
    c.area++;
  }
  return Array.from(map.values());
}

function grayToCanvas(canvas: HTMLCanvasElement, gray: Uint8Array, w: number, h: number) {
  canvas.width=w; canvas.height=h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w,h);
  for (let i=0;i<gray.length;i++) {
    img.data[i*4]=img.data[i*4+1]=img.data[i*4+2]=gray[i]; img.data[i*4+3]=255;
  }
  ctx.putImageData(img,0,0);
}

function binaryToCanvas(canvas: HTMLCanvasElement, bin: Uint8Array, w: number, h: number) {
  canvas.width=w; canvas.height=h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w,h);
  for (let i=0;i<bin.length;i++) {
    const v = bin[i]?255:0;
    img.data[i*4]=img.data[i*4+1]=img.data[i*4+2]=v; img.data[i*4+3]=255;
  }
  ctx.putImageData(img,0,0);
}

function blobsToCanvas(canvas: HTMLCanvasElement, bin: Uint8Array, blobs: BlobInfo[], w: number, h: number, frameArea: number) {
  binaryToCanvas(canvas,bin,w,h);
  const ctx = canvas.getContext("2d")!;
  blobs.forEach((b,i) => {
    const bw=b.maxX-b.minX+1, bh=b.maxY-b.minY+1;
    const aspect=bw/bh;
    const areaFrac=b.area/frameArea;
    const pass = areaFrac>0.005 && areaFrac<0.55 && aspect>1.1 && aspect<9.0;
    ctx.strokeStyle = pass ? "#22c55e" : "#ef4444";
    ctx.lineWidth=2;
    ctx.strokeRect(b.minX,b.minY,bw,bh);
    ctx.fillStyle = pass ? "#22c55e" : "#ef4444";
    ctx.font="bold 10px sans-serif";
    ctx.fillText(`${i} a=${(areaFrac*100).toFixed(1)}% r=${aspect.toFixed(1)}`,b.minX,b.minY-2);
  });
}

export default function DebugPage() {
  const { videoRef, status: camStatus } = useCamera();
  const grayRef   = useRef<HTMLCanvasElement>(null);
  const binRef    = useRef<HTMLCanvasElement>(null);
  const closeRef  = useRef<HTMLCanvasElement>(null);
  const blobRef   = useRef<HTMLCanvasElement>(null);

  const [info, setInfo] = useState<string>("Tap Analyze to run pipeline");
  const [otsuVal, setOtsuVal] = useState<number>(0);

  const analyze = useCallback(() => {
    const video = videoRef.current;
    if (!video || camStatus!=="ready") { setInfo("Camera not ready"); return; }

    const frame = extractFrame(video, 0.5);
    if (!frame) { setInfo("extractFrame returned null — videoWidth="+video.videoWidth); return; }

    const { width: w, height: h } = frame;
    const frameArea = w*h;

    const gray    = frameToGrayscale(frame);
    const blurred = blur3(gray,w,h);
    const t       = otsuThreshold(blurred);
    setOtsuVal(t);

    const binary = new Uint8Array(w*h);
    for (let i=0;i<blurred.length;i++) binary[i]=blurred[i]<=t?1:0;

    const closed = morphOp(morphOp(binary,w,h,12,true),w,h,12,false);
    const blobs  = findBlobs(closed,w,h);
    blobs.sort((a,b)=>(b.maxX-b.minX+1)*(b.maxY-b.minY+1)-(a.maxX-a.minX+1)*(a.maxY-a.minY+1));

    if (grayRef.current)  grayToCanvas(grayRef.current, blurred, w, h);
    if (binRef.current)   binaryToCanvas(binRef.current, binary, w, h);
    if (closeRef.current) binaryToCanvas(closeRef.current, closed, w, h);
    if (blobRef.current)  blobsToCanvas(blobRef.current, closed, blobs.slice(0,10), w, h, frameArea);

    const passing = blobs.filter(b => {
      const bw=b.maxX-b.minX+1,bh=b.maxY-b.minY+1;
      const aspect=bw/bh, af=b.area/frameArea;
      return af>0.005&&af<0.55&&aspect>1.1&&aspect<9.0;
    });

    setInfo(
      `Frame: ${w}×${h} | Otsu T=${t} | Blobs total: ${blobs.length} | Passing filter: ${passing.length}\n` +
      blobs.slice(0,8).map((b,i)=>{
        const bw=b.maxX-b.minX+1,bh=b.maxY-b.minY+1;
        return `[${i}] area=${(b.area/frameArea*100).toFixed(1)}% aspect=${(bw/bh).toFixed(2)} bbox=${bw}×${bh}`;
      }).join("\n")
    );
  }, [videoRef, camStatus]);

  // Auto-analyze every 2s once camera ready
  useEffect(() => {
    if (camStatus !== "ready") return;
    const id = setInterval(analyze, 2000);
    return () => clearInterval(id);
  }, [camStatus, analyze]);

  const stages = [
    { ref: grayRef,  label: "1. Grayscale + blur" },
    { ref: binRef,   label: `2. Otsu binary (T=${otsuVal})` },
    { ref: closeRef, label: "3. Morphological close" },
    { ref: blobRef,  label: "4. Blobs (green=passes filter)" },
  ];

  return (
    <div style={{ background:"#080810", minHeight:"100vh", padding:"16px", color:"#fff", fontFamily:"monospace" }}>
      <h1 style={{ fontSize:16, fontWeight:"bold", marginBottom:8, color:"#06b6d4" }}>CV Debug — stridevision</h1>

      {/* Live feed */}
      <div style={{ borderRadius:12, overflow:"hidden", background:"#000", marginBottom:12, maxWidth:480 }}>
        <video ref={videoRef} style={{ width:"100%", display:"block" }} playsInline muted autoPlay />
      </div>

      <button
        onClick={analyze}
        style={{ background:"linear-gradient(135deg,#06b6d4,#3b82f6)", border:"none", borderRadius:8, padding:"10px 20px", color:"#000", fontWeight:"bold", fontSize:14, marginBottom:16, cursor:"pointer" }}
      >
        Analyze Now
      </button>

      {/* Stage canvases */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:16 }}>
        {stages.map(({ ref, label }) => (
          <div key={label}>
            <p style={{ fontSize:11, color:"#555", marginBottom:4 }}>{label}</p>
            <canvas
              ref={ref}
              style={{ width:"100%", display:"block", borderRadius:6, border:"1px solid #222", imageRendering:"pixelated" }}
            />
          </div>
        ))}
      </div>

      {/* Info dump */}
      <pre style={{ fontSize:11, color:"#888", background:"#0d0d1a", borderRadius:8, padding:12, whiteSpace:"pre-wrap", wordBreak:"break-all" }}>
        {info}
      </pre>
    </div>
  );
}
