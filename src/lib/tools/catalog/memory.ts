import {
  getProjectContextTool,
  updateProjectContextTool,
} from "../../projectContext/tools.ts";
import { defineRegistration, type ToolRegistration } from "../types.ts";

const exampleContext = {
  brandKey: "brand-example",
  sections: [],
  missingSections: [],
  customSections: [],
  competitors: [],
  keyPages: [],
  researchLog: [],
  researchLogLimited: false,
  brandIdentity: {
    displayName: "Example Co",
    website: "https://example.test",
    matchNames: ["Example Co"],
  },
};

export const registrations: ToolRegistration[] = [
  defineRegistration({
    def: getProjectContextTool as never,
    area: "memory",
    feature: "project_memory",
    effect: "read",
    approval: () => ({ kind: "none" }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    summarize: (output: any) => {
      const context = output?.context ?? {};

      return (
        "Workspace memory: " +
        (context.sections?.length ?? 0) +
        " sections, " +
        (context.competitors?.length ?? 0) +
        " competitors, " +
        (context.keyPages?.length ?? 0) +
        " key pages."
      );
    },
    link: () => ({ path: "/portal/context", label: "Context" }),
    example: {
      input: {},
      output: { markdown: "Workspace memory.", context: exampleContext },
    },
  }),
  defineRegistration({
    def: updateProjectContextTool as never,
    area: "memory",
    feature: "project_memory",
    effect: "write",
    approval: () => ({ kind: "none" }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: false,
    },
    summarize: (_output: any, input: any) =>
      "Updated workspace memory (" +
      (input?.updates?.length ?? 0) +
      " changes).",
    link: () => ({ path: "/portal/context", label: "Context" }),
    example: {
      input: {
        updates: [
          { section: "business_overview", content: "Example business." },
        ],
      },
      output: { markdown: "Workspace memory updated." },
    },
  }),
];
