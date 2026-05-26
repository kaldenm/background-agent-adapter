import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { getToken } from "next-auth/jwt";
import { authOptions } from "@/lib/auth";
import { serverFetch } from "@/lib/server";
import { buildServerPath, SESSION_SERVER_QUERY_PARAMS } from "@/lib/server-query";

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const path = buildServerPath(
    "/sessions",
    request.nextUrl.searchParams,
    SESSION_SERVER_QUERY_PARAMS
  );

  try {
    const response = await serverFetch(path);
    const data = await response.json();

    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to fetch sessions:", error);
    return NextResponse.json({ error: "Failed to fetch sessions" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();

    const jwt = await getToken({ req: request });
    const accessToken = jwt?.accessToken as string | undefined;

    // Explicitly pick allowed fields from client body and derive identity
    // from the server-side NextAuth session (not client-supplied data)
    const user = session.user;
    const userId = user.id || user.email || "anonymous";

    // All session creation goes through the scheduler — single source of truth.
    const dispatchBody = {
      session: {
        repoOwner: body.repoOwner,
        repoName: body.repoName,
        userId,
        spawnSource: "user" as const,
        model: body.model,
        reasoningEffort: body.reasoningEffort,
        branch: body.branch,
        title: body.title,
        scmToken: accessToken,
        scmRefreshToken: jwt?.refreshToken as string | undefined,
        scmTokenExpiresAt: jwt?.accessTokenExpiresAt as number | undefined,
        scmUserId: user.id,
        scmLogin: user.login,
        scmName: user.name,
        scmEmail: user.email,
      },
      prompt: {
        content: body.prompt || body.title || "Start session",
        authorId: userId,
        source: "user",
      },
    };

    const response = await serverFetch("/scheduler/dispatch", {
      method: "POST",
      body: JSON.stringify(dispatchBody),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("Failed to create session:", error);
    return NextResponse.json({ error: "Failed to create session" }, { status: 500 });
  }
}
