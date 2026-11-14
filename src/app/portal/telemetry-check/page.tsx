import { notFound } from "next/navigation";
import { TelemetryCheckButton } from "./telemetry-check-button";

// F26 error-report check page. Unreachable in production: renders only on a
// preview deployment or a non-production build (live T4 expects 404 in
// production). No nav entry points here.

export default function TelemetryCheckPage() {
  if (process.env.VERCEL_ENV !== "preview" && process.env.NODE_ENV === "production") {
    notFound();
  }
  return <TelemetryCheckButton />;
}
