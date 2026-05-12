// Copies Pretendard variable woff2 from node_modules into src/app/fonts/
// so next/font/local can pick it up via a relative path.
//
// Runs as a postinstall step. Safe to re-run.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const destDir = resolve(projectRoot, "src/app/fonts");
mkdirSync(destDir, { recursive: true });

const copies = [
  {
    label: "PretendardVariable.woff2 (UI text via next/font/local)",
    source: resolve(
      projectRoot,
      "node_modules/pretendard/dist/web/variable/woff2/PretendardVariable.woff2",
    ),
    dest: resolve(destDir, "PretendardVariable.woff2"),
  },
  {
    label: "Pretendard-Bold.woff (OG image rendering)",
    source: resolve(
      projectRoot,
      "node_modules/pretendard/dist/web/static/woff/Pretendard-Bold.woff",
    ),
    dest: resolve(destDir, "Pretendard-Bold.woff"),
  },
  {
    label: "Pretendard-Regular.woff (OG image rendering)",
    source: resolve(
      projectRoot,
      "node_modules/pretendard/dist/web/static/woff/Pretendard-Regular.woff",
    ),
    dest: resolve(destDir, "Pretendard-Regular.woff"),
  },
];

for (const { label, source, dest } of copies) {
  if (!existsSync(source)) {
    console.warn(`[copy-fonts] Missing ${label}: ${source}. Run 'pnpm install' to restore.`);
    continue;
  }
  copyFileSync(source, dest);
  console.log(`[copy-fonts] Copied ${label} → ${dest}`);
}
