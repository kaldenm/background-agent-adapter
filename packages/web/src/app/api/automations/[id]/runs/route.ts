import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { serverFetch } from "@/lib/server";
import { buildServerPath } from "@/lib/server-query";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const path = buildServerPath(`/automations/${id}/runs`, request.nextUrl.searchParams);

  try {
    const response = await serverFetch(path);
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch automation runs:", error);
    return NextResponse.json({ error: "Failed to fetch automation runs" }, { status: 500 });
  }
}
