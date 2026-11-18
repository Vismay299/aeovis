// F23 §6.6 — start the assistant on a template. New component (no OpenSEO
// source): the Generate button and the template row menu open it, and a
// successful start navigates to the new assistant session.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fetchJson } from "@/shared/query/fetchJson";
import { describeError } from "@/shared/query/errors";
import { formatUsd } from "@/shared/money";
import { assistantConfigQueryOptions } from "@/components/portal/assistant/hooks/useAssistantSessions.ts";
import {
  reportTemplatesQueryOptions,
  type ReportTemplateItem,
} from "./hooks/useReports.ts";

export function GenerateReportDialog({
  brandKey,
  initialTemplateId,
  onClose,
}: {
  brandKey: string;
  initialTemplateId?: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const templatesQuery = useQuery(reportTemplatesQueryOptions(brandKey));
  const configQuery = useQuery(assistantConfigQueryOptions(brandKey));
  const templates: ReportTemplateItem[] = templatesQuery.data?.templates ?? [];
  const [templateId, setTemplateId] = useState<string | undefined>(
    initialTemplateId,
  );
  // The select stays on the row that opened the dialog; fall back to the first
  // template once the list lands when the dialog was opened without one.
  const selectedId =
    templateId ?? (templates.length === 1 ? templates[0].id : undefined);

  const generateMutation = useMutation({
    // The failure belongs to the dialog ("Errors inline"), not the toast.
    meta: { errorToast: false },
    mutationFn: (id: string) =>
      fetchJson<{ sessionId: string; path: string }>(
        "/api/customer/reports/generate",
        { method: "POST", body: { brand_key: brandKey, templateId: id } },
      ),
    onSuccess: (result) => {
      router.push(result.path);
    },
  });

  const turnMaxUsd = configQuery.data?.turnMaxUsd;
  const pending = generateMutation.isPending;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent fullScreenOnMobile className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Generate a report</DialogTitle>
        </DialogHeader>

        {templatesQuery.isPending ? (
          <DialogDescription>Loading templates…</DialogDescription>
        ) : templatesQuery.isError ? (
          <p className="text-sm text-destructive">
            {describeError(
              templatesQuery.error,
              "Could not load the templates.",
            )}
          </p>
        ) : templates.length === 0 ? (
          <div className="space-y-4">
            <DialogDescription>
              Create a template first. It tells the assistant who the report is
              for and which sections it needs.
            </DialogDescription>
            <Button
              onClick={() => {
                onClose();
                router.push("/portal/reports/templates");
              }}
            >
              New template
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <Field>
              <FieldLabel htmlFor="generate-report-template">
                Template
              </FieldLabel>
              <Select
                value={selectedId ?? ""}
                onValueChange={(value) => setTemplateId(value ?? undefined)}
                disabled={pending}
              >
                <SelectTrigger
                  id="generate-report-template"
                  className="w-full"
                >
                  <SelectValue placeholder="Choose a template" />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((template) => (
                    <SelectItem key={template.id} value={template.id}>
                      {template.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <DialogDescription>
              The assistant reads your workspace data and writes the report. It
              may ask you to approve paid lookups. Each assistant reply uses up
              to{" "}
              {turnMaxUsd !== undefined
                ? formatUsd(turnMaxUsd)
                : "an amount shown in the assistant"}
              .
            </DialogDescription>
            {generateMutation.isError ? (
              <p className="text-sm text-destructive">
                {describeError(generateMutation.error)}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </Button>
          {templates.length > 0 && !templatesQuery.isError ? (
            <Button
              pending={pending}
              disabled={!selectedId}
              onClick={() => {
                if (selectedId) void generateMutation.mutateAsync(selectedId);
              }}
            >
              {pending ? "Starting…" : "Start"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
