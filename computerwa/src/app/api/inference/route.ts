import { NextResponse } from "next/server";
import { loadInferenceStatus } from "@/lib/inference/server";

export const dynamic = "force-dynamic";

const ALLOWED = new Set(["1", "7", "30", "90", "all"]);

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("days") ?? "30";
  if (!ALLOWED.has(q)) {
    return NextResponse.json({ error: { message: "days must be one of 1, 7, 30, 90, all", code: "invalid_range" } }, { status: 400 });
  }
  const status = await loadInferenceStatus(q === "all" ? "all" : Number(q));
  return NextResponse.json(status, { headers: { "cache-control": "no-store" } });
}
