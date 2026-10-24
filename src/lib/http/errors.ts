import { ZodError } from "zod";
import { AppError, WorkspaceError, isAppError } from "./appError.ts";

export { AppError, WorkspaceError, isAppError };

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export const NO_STORE: HeadersInit = NO_STORE_HEADERS;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...NO_STORE_HEADERS, "Content-Type": "application/json" },
  });
}

export function jsonOk(body: unknown, status: number = 200): Response {
  return json(body, status);
}

/**
 * Reads a JSON request body. A body that is not JSON is a client error; any
 * other SyntaxError stays a server error, so an internal JSON.parse failure is
 * never reported as a bad request. A failure that is not a parse failure (an
 * already-consumed body, a stream error) is a bug, so it is rethrown and ends
 * up as a logged 500 rather than a silent 400.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new AppError(400, "invalid_json", "The request body must be JSON.");
    }
    throw err;
  }
}

export function toErrorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    const body: Record<string, unknown> = { error: err.message, code: err.code };
    if (err.recovery !== undefined) body.recovery = err.recovery;
    if (err.details !== undefined) body.details = err.details;
    return json(body, err.status);
  }

  if (err instanceof ZodError) {
    return json(
      {
        error: "The request was not valid.",
        code: "invalid_request",
        details: {
          issues: err.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      },
      400
    );
  }

  console.error(
    "[http] unhandled",
    err instanceof Error ? err.name + ": " + err.message.slice(0, 200) : typeof err
  );
  return json({ error: "Something went wrong. Please retry.", code: "internal_error" }, 500);
}
