import { submitIndexNowUrlsTool } from "../../indexnow/tools.ts";
import { defineRegistration, type ToolRegistration } from "../types.ts";
import { externalAnnotations } from "./quote.ts";

export const registrations: ToolRegistration[] = [
  defineRegistration({
    def: submitIndexNowUrlsTool as never,
    area: "indexnow",
    feature: "indexnow",
    effect: "external",
    approval: (_ctx, input) => ({
      kind: "confirm",
      label:
        "Tell IndexNow search engines that " +
        (Array.isArray(input.urls) ? input.urls.length : 0) +
        " URLs changed",
    }),
    annotations: externalAnnotations(),
    summarize: (output: any) => {
      const accepted = (output?.hosts ?? [])
        .filter((host: any) => host?.status === "submitted")
        .reduce(
          (sum: number, host: any) => sum + (host?.urlCount ?? 0),
          0,
        );
      return (
        "Submitted " +
        accepted +
        " URLs to IndexNow; skipped " +
        (output?.skipped?.length ?? 0) +
        "."
      );
    },
    link: () => ({ path: "/portal/audit", label: "Site audit" }),
    example: {
      input: { urls: ["https://acme.example/page"] },
      output: { key: "example-key", keyCreated: false, hosts: [], skipped: [] },
    },
  }),
];
