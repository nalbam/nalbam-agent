import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

import { clientEnv } from "@/lib/env";

export const runtime = "nodejs";
export const alt = clientEnv.NEXT_PUBLIC_APP_NAME;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const fontDir = join(process.cwd(), "src", "app", "fonts");

export default async function OgImage() {
  const [bold, regular] = await Promise.all([
    readFile(join(fontDir, "Pretendard-Bold.woff")),
    readFile(join(fontDir, "Pretendard-Regular.woff")),
  ]);

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "80px",
        background: "radial-gradient(circle at top left, #1e293b 0%, #020617 60%)",
        color: "#f1f5f9",
        fontFamily: "Pretendard, Inter, system-ui, sans-serif",
      }}
    >
      <div
        style={{
          fontSize: 28,
          letterSpacing: 8,
          textTransform: "uppercase",
          color: "#67e8f9",
          marginBottom: 24,
          fontWeight: 400,
        }}
      >
        Production-ready starter
      </div>
      <div
        style={{
          fontSize: 84,
          fontWeight: 700,
          lineHeight: 1.1,
          display: "flex",
        }}
      >
        {clientEnv.NEXT_PUBLIC_APP_NAME}
      </div>
      <div
        style={{
          display: "flex",
          marginTop: 32,
          fontSize: 32,
          color: "#94a3b8",
          maxWidth: 980,
          fontWeight: 400,
        }}
      >
        Next.js 16 · Better Auth · DynamoDB · Tailwind v4
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: "Pretendard", data: regular, style: "normal", weight: 400 },
        { name: "Pretendard", data: bold, style: "normal", weight: 700 },
      ],
    },
  );
}
