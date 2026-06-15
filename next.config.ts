import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: true },
  images: {
    remotePatterns: [{ protocol: "https", hostname: "dbpidvgqfrksgyqkddqf.supabase.co" }],
  },
  // Required for onnxruntime-web SharedArrayBuffer (WASM threads)
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy",   value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy",  value: "require-corp" },
        ],
      },
    ];
  },
  // Silence Turbopack warning — no webpack config needed (onnxruntime-web
  // serves WASM from /public, fs fallback not required in Next.js 16)
  turbopack: {},
};

export default nextConfig;
