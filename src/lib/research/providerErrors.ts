import { AppError } from "../http/appError.ts";
import {
  SpendRefused,
  ChargedCallError,
  UnbilledCallError,
  AmbiguousCallError,
} from "../spend/errors.ts";
import { CacheOnlyMiss } from "./cache.ts";

export function toResearchError(
  err: unknown,
  o: { unavailableCode: string; unavailableMessage: string },
): unknown {
  if (err instanceof SpendRefused || err instanceof CacheOnlyMiss) {
    return err;
  }

  if (err instanceof AppError) {
    if (err.code === "dataforseo_invalid_field") {
      return new AppError(
        422,
        "research_invalid",
        "DataForSEO could not use this input. Try a different keyword or market.",
        { cause: err },
      );
    }
    if (err.code === "dataforseo_not_configured") {
      return new AppError(
        503,
        "research_not_configured",
        "Research data is not configured yet. Contact Perceev support.",
        { cause: err },
      );
    }
    if (err.code.startsWith("dataforseo_")) {
      return new AppError(502, o.unavailableCode, o.unavailableMessage, {
        details: { providerCode: err.code },
        cause: err,
      });
    }
    return err;
  }

  if (
    err instanceof UnbilledCallError ||
    err instanceof ChargedCallError ||
    err instanceof AmbiguousCallError
  ) {
    const rawCode = err.code ?? (err.details?.providerCode as string | undefined);
    if (rawCode === "dataforseo_invalid_field") {
      return new AppError(
        422,
        "research_invalid",
        "DataForSEO could not use this input. Try a different keyword or market.",
        { cause: err },
      );
    }
    if (rawCode === "dataforseo_not_configured") {
      return new AppError(
        503,
        "research_not_configured",
        "Research data is not configured yet. Contact Perceev support.",
        { cause: err },
      );
    }
    const providerCode = rawCode ?? "dataforseo_call_failed";
    return new AppError(502, o.unavailableCode, o.unavailableMessage, {
      details: { providerCode },
      cause: err,
    });
  }

  return err;
}
