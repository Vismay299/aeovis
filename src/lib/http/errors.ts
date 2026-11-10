import { ZodError } from "zod";
import { AppError, WorkspaceError, isAppError } from "./appError.ts";
import { isCallOutcomeError } from "../spend/errors.ts";

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

/**
 * Like `readJsonBody`, but a missing or blank body is `{}` instead of a 400, for
 * routes whose every field is optional. An unreadable body is `invalid_request`;
 * a body that is not JSON is `invalid_json`.
 */
export async function readOptionalJsonBody(request: Request): Promise<unknown> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new AppError(400, "invalid_request", "The request body could not be read.");
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(400, "invalid_json", "The request body must be JSON.");
  }
}

export function toErrorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    const body: Record<string, unknown> = { error: err.message, code: err.code };
    if (err.recovery !== undefined) body.recovery = err.recovery;
    if (err.details !== undefined) body.details = err.details;
    return json(body, err.status);
  }

  if (
    isCallOutcomeError(err) &&
    Number.isInteger(err.status) &&
    (err.status as number) >= 400 &&
    (err.status as number) <= 599 &&
    typeof err.code === "string" &&
    err.code.length > 0
  ) {
    const body: Record<string, unknown> = { error: err.message, code: err.code };
    if (err.details !== undefined) body.details = err.details;
    return json(body, err.status as number);
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
