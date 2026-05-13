"use client";

import { useMemo } from "react";
import type { CaptureAngle } from "@/types/database";
import { getAlignmentColor } from "@/lib/utils";
import { cn } from "@/lib/utils";

interface Props {
  angle: CaptureAngle;
  alignmentScore: number;
  tiltX: number;
  tiltY: number;
}

// SVG shoe silhouette paths per angle
const SILHOUETTES: Record<CaptureAngle, string> = {
  top: "M 80 50 Q 80 30 120 28 L 280 28 Q 340 28 360 50 L 370 80 Q 375 100 360 120 L 340 140 Q 300 160 240 162 L 160 162 Q 100 160 80 140 L 70 110 Q 65 90 80 50 Z",
  left: "M 60 120 Q 60 80 100 70 L 200 65 Q 260 62 300 70 L 340 80 Q 370 95 370 120 L 370 160 Q 370 185 340 195 L 100 195 Q 65 185 60 160 Z",
  right: "M 70 120 Q 70 80 100 70 L 200 65 Q 260 62 310 70 L 350 80 Q 380 95 380 120 L 380 160 Q 380 185 350 195 L 100 195 Q 68 185 70 160 Z",
  front: "M 100 40 Q 100 25 140 22 L 300 22 Q 340 25 340 40 L 345 110 Q 345 160 300 170 L 140 170 Q 95 160 95 110 Z",
  back: "M 95 40 Q 95 22 140 20 L 300 20 Q 345 22 345 40 L 350 115 Q 350 165 300 175 L 140 175 Q 90 165 95 115 Z",
  sole: "M 75 55 Q 75 32 115 28 L 285 28 Q 345 30 365 55 L 375 85 Q 380 108 365 128 L 345 148 Q 305 168 245 170 L 155 170 Q 95 168 75 148 L 65 118 Q 60 95 75 55 Z",
};

// Angle labels and instructions
const ANGLE_META: Record<CaptureAngle, { label: string; rotation: string; hint: string }> = {
  top: { label: "TOP VIEW", rotation: "Flat — directly above", hint: "Hold phone parallel to ground" },
  left: { label: "LEFT SIDE", rotation: "90° — left side", hint: "Shoot from left side profile" },
  right: { label: "RIGHT SIDE", rotation: "90° — right side", hint: "Shoot from right side profile" },
  front: { label: "FRONT VIEW", rotation: "Head-on — toe cap", hint: "Position camera facing toe" },
  back: { label: "BACK VIEW", rotation: "Head-on — heel", hint: "Position camera facing heel" },
  sole: { label: "SOLE / BOTTOM", rotation: "Flip shoe upside down", hint: "Show sole facing camera" },
};

function AlignmentCorners({ score }: { score: number }) {
  const color = getAlignmentColor(score);
  const size = 20;
  const corners = [
    { x: 30, y: 30, rx: [0, size], ry: [0, size] },
    { x: 410, y: 30, rx: [-size, 0], ry: [0, size] },
    { x: 30, y: 250, rx: [0, size], ry: [-size, 0] },
    { x: 410, y: 250, rx: [-size, 0], ry: [-size, 0] },
  ];

  return (
    <g className="corner-guide">
      {corners.map((c, i) => (
        <g key={i} transform={`translate(${c.x}, ${c.y})`}>
          <line x1="0" y1="0" x2={c.rx[0]} y2="0" stroke={color} strokeWidth="2" />
          <line x1="0" y1="0" x2="0" y2={c.ry[1] || c.ry[0]} stroke={color} strokeWidth="2" />
        </g>
      ))}
    </g>
  );
}

function TiltIndicator({ tiltX, tiltY, score }: { tiltX: number; tiltY: number; score: number }) {
  const color = getAlignmentColor(score);
  const clampedX = Math.max(-30, Math.min(30, tiltX));
  const clampedY = Math.max(-30, Math.min(30, tiltY));
  const dotX = 220 + clampedX * 2;
  const dotY = 140 + clampedY * 2;

  return (
    <g transform="translate(180, 100)">
      {/* Cross hairs */}
      <circle cx="40" cy="40" r="36" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
      <circle cx="40" cy="40" r="20" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
      <line x1="4" y1="40" x2="76" y2="40" stroke="rgba(255,255,255,0.12)" strokeWidth="0.5" />
      <line x1="40" y1="4" x2="40" y2="76" stroke="rgba(255,255,255,0.12)" strokeWidth="0.5" />
      {/* Moving dot */}
      <circle
        cx={40 + clampedX}
        cy={40 + clampedY}
        r="5"
        fill={color}
        style={{ transition: "cx 0.15s, cy 0.15s" }}
      />
      {/* Center target */}
      <circle cx="40" cy="40" r="2" fill="rgba(255,255,255,0.3)" />
    </g>
  );
}

export function AlignmentOverlay({ angle, alignmentScore, tiltX, tiltY }: Props) {
  const meta = ANGLE_META[angle];
  const silhouette = SILHOUETTES[angle];
  const scoreColor = getAlignmentColor(alignmentScore);
  const isPerfect = alignmentScore >= 85;

  return (
    <div className="absolute inset-0 pointer-events-none">
      <svg
        viewBox="0 0 440 280"
        className="absolute inset-0 w-full h-full"
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Dark vignette */}
        <defs>
          <radialGradient id="vignette" cx="50%" cy="50%" r="50%">
            <stop offset="40%" stopColor="transparent" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.6)" />
          </radialGradient>
          <filter id="glow">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <rect width="440" height="280" fill="url(#vignette)" />

        {/* Ghost silhouette */}
        <path
          d={silhouette}
          fill="none"
          stroke={scoreColor}
          strokeWidth="1.5"
          strokeDasharray={isPerfect ? "0" : "6,4"}
          opacity={isPerfect ? 0.6 : 0.35}
          style={{ transition: "stroke 0.3s, opacity 0.3s" }}
          filter={isPerfect ? "url(#glow)" : undefined}
        />

        {/* Corner alignment guides */}
        <AlignmentCorners score={alignmentScore} />

        {/* Tilt indicator */}
        <TiltIndicator tiltX={tiltX} tiltY={tiltY} score={alignmentScore} />

        {/* Scan line when perfect */}
        {isPerfect && (
          <g>
            <rect
              x="30"
              y="0"
              width="380"
              height="2"
              fill={scoreColor}
              opacity="0.6"
              className="animate-scan-line"
            />
          </g>
        )}
      </svg>

      {/* Angle label — top */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/50 backdrop-blur-sm border border-white/10">
          <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: scoreColor }} />
          <span className="text-white text-xs font-semibold tracking-widest">
            {meta.label}
          </span>
        </div>
      </div>

      {/* Alignment score — bottom center */}
      <div className="absolute bottom-16 left-1/2 -translate-x-1/2">
        <div className="flex flex-col items-center gap-2">
          {/* Score bar */}
          <div className="w-32 h-1 rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${alignmentScore}%`,
                backgroundColor: scoreColor,
              }}
            />
          </div>
          <div
            className="text-sm font-semibold tabular-nums"
            style={{ color: scoreColor, textShadow: `0 0 10px ${scoreColor}40` }}
          >
            {alignmentScore.toFixed(0)}% aligned
          </div>
        </div>
      </div>

      {/* Instruction hint */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-full px-8">
        <p className="text-white/60 text-xs text-center">{meta.hint}</p>
      </div>

      {/* Perfect alignment flash */}
      {isPerfect && (
        <div
          className="absolute inset-0 border-2 rounded-lg animate-pulse-ring"
          style={{ borderColor: scoreColor }}
        />
      )}
    </div>
  );
}
