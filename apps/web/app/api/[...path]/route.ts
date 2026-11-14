import { createApp } from "@leadwork/core";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
let app: ReturnType<typeof createApp> | undefined;
async function handle(request: Request) {
  try {
    return (app ??= createApp()).handle(request);
  } catch {
    return Response.json(
      {
        error: {
          code: "provider_not_ready",
          status: 422,
          message: "A required provider connection or policy is not ready.",
        },
      },
      { status: 422, headers: { "cache-control": "no-store" } },
    );
  }
}
export {
  handle as GET,
  handle as POST,
  handle as PATCH,
  handle as PUT,
  handle as DELETE,
};
