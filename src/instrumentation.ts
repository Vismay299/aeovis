export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { wireServerSinks } = await import("./shared/telemetry/wireServerSinks.ts");
  wireServerSinks();
}

export async function onRequestError(
  error: unknown,
  _request: unknown,
  context: { routePath?: string; routeType?: string; routerKind?: string } | undefined,
) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { captureServerError } = await import("./shared/telemetry/server.ts");
  // Route template only, sliced to 64 chars. The request (path, headers) is never read.
  void _request;
  await captureServerError(error, { route: String(context?.routePath ?? "unknown").slice(0, 64) });
}
