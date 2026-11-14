"use client";

// F26 telemetry-check button. Throws on click so the browser check (B7) can
// assert the report carries type/stack only — never this message.

export function TelemetryCheckButton() {
  return (
    <button
      type="button"
      onClick={() => {
        throw new Error("telemetry check: secret-content");
      }}
    >
      Throw test error
    </button>
  );
}
