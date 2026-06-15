import { copyFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const src = join(root, "node_modules", "onnxruntime-web", "dist");
const dst = join(root, "public");

mkdirSync(dst, { recursive: true });

const files = [
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
  "ort-wasm-simd-threaded.asyncify.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
];

for (const f of files) {
  const s = join(src, f);
  if (existsSync(s)) {
    copyFileSync(s, join(dst, f));
    console.log(`copied ${f}`);
  } else {
    console.warn(`missing ${f} in onnxruntime-web/dist — skipping`);
  }
}
