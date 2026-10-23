import { ZodError } from "zod";
import { AppError, WorkspaceError, isAppError } from "./appError.ts";
import { SpendRefused } from "../spend/errors.ts";

export { AppError, WorkspaceError, isAppError };

export const NO_STORE: HeadersInit = { "Cache-Control": "no-store" };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
  });
}

export function jsonOk(body: unknown, status: number = 200): Response {
  return json(body, status);
}

export function toErrorResponse(err: unknown): Response {
  if (err instanceof SpendRefused) {
    const body: Record<string, unknown> = { error: err.message, code: err.code };
    if (err.recovery !== undefined) body.recovery = err.recovery;
    if (err.details !== undefined) body.details = err.details;
    return json(body, err.status);
  }

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

  if (err instanceof SyntaxError) {
    return json({ error: "The request body must be JSON.", code: "invalid_json" }, 400);
  }

  console.error(
    "[http] unhandled",
    err instanceof Error ? err.name + ": " + err.message.slice(0, 200) : typeof err
  );
  return json({ error: "Something went wrong. Please retry.", code: "internal_error" }, 500);
}
