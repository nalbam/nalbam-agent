import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { NextResponse, type NextRequest } from "next/server";

import { getDynamoClient, getTableName } from "@/lib/dynamodb";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface HealthBody {
  status: "ok" | "degraded";
  timestamp: string;
  uptime: number;
  nodeVersion: string;
  checks?: {
    dynamodb?: { ok: boolean; latencyMs: number; error?: string };
  };
}

const probeDynamo = async (): Promise<{ ok: boolean; latencyMs: number; error?: string }> => {
  const started = Date.now();
  try {
    await getDynamoClient().send(new DescribeTableCommand({ TableName: getTableName() }));
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export async function GET(request: NextRequest) {
  const probe = request.nextUrl.searchParams.get("probe");
  const body: HealthBody = {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    nodeVersion: process.version,
  };

  if (probe === "db" || probe === "all") {
    const dynamodb = await probeDynamo();
    body.checks = { dynamodb };
    if (!dynamodb.ok) body.status = "degraded";
  }

  return NextResponse.json(body, { status: body.status === "ok" ? 200 : 503 });
}
