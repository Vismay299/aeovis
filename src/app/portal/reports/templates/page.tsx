// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/routes/_app/p/$projectId/reports/templates.tsx:27-125
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useState } from "react";
import { notFound } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { usePortal } from "@/components/portal/PortalShell";
import { BackLink, PageHeader } from "@/components/app/PageHeader";
import { QueryError } from "@/components/app/QueryState";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { StatusScreen } from "@/components/app/StatusScreen";
import { SkeletonTableRows } from "@/components/app/SkeletonPresets";
import { Button } from "@/components/ui/button";
import { TableCard } from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { keys } from "@/shared/query/keys";
import { fetchJson } from "@/shared/query/fetchJson";
import { describeError } from "@/shared/query/errors";
import { trackEvent } from "@/shared/telemetry/client";
import { REPORT_TEMPLATE_MAX_PER_WORKSPACE } from "@/shared/reports";
import { ReportTemplatesList } from "@/components/portal/reports/ReportTemplatesList.tsx";
import { ReportTemplateForm } from "@/components/portal/reports/ReportTemplateForm.tsx";
import { GenerateReportDialog } from "@/components/portal/reports/GenerateReportDialog.tsx";
import {
  reportTemplatesQueryOptions,
  type ReportTemplateItem,
} from "@/components/portal/reports/hooks/useReports.ts";

export default function ReportTemplatesRoutePage() {
  const { brandKey, features } = usePortal();
  const queryClient = useQueryClient();
  // `{}` opens the form for a new template; `{ template }` opens it for an edit.
  const [form, setForm] = useState<{ template?: ReportTemplateItem } | null>(
    null,
  );
  const [pendingDelete, setPendingDelete] =
    useState<ReportTemplateItem | null>(null);
  const [generateFor, setGenerateFor] =
    useState<ReportTemplateItem | null>(null);

  // The flag decides: with `reports` off the page does not exist.
  if (features && features.reports === false) {
    notFound();
  }

  const templatesQuery = useQuery(reportTemplatesQueryOptions(brandKey));

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: keys.reportTemplates(brandKey),
    });
    // The reports list renders the template name in its Type column.
    void queryClient.invalidateQueries({
      queryKey: keys.reports(brandKey),
    });
  };

  const deleteMutation = useMutation({
    mutationFn: (templateId: string) =>
      fetchJson<{ templateId: string; deleted: boolean }>(
        `/api/customer/reports/templates/${encodeURIComponent(templateId)}`,
        { method: "DELETE", body: { brand_key: brandKey } },
      ),
    onSuccess: () => {
      trackEvent("report_template:deleted", {});
      toast.success("Template deleted");
      setPendingDelete(null);
      invalidate();
    },
    onError: (error) => {
      toast.error(
        describeError(error, "Could not delete this template."),
      );
    },
  });

  if (!features || !brandKey) {
    return <StatusScreen pending />;
  }

  const remaining = templatesQuery.data?.remaining;
  const limitReached = remaining === 0;
  const canGenerate =
    features.report_generate === true && features.assistant === true;

  const newButton = (
    <Button
      onClick={() => setForm({})}
      disabled={limitReached || templatesQuery.isPending}
    >
      <Plus data-icon="inline-start" />
      New template
    </Button>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        backLink={<BackLink href="/portal/reports">Reports</BackLink>}
        title="Report templates"
        description="Reusable briefs the assistant follows when it writes a report: who it is for, which sections it has, and how it should sound."
        actions={
          limitReached ? (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                {newButton}
              </TooltipTrigger>
              <TooltipContent>
                You have {REPORT_TEMPLATE_MAX_PER_WORKSPACE} templates, the
                limit.
              </TooltipContent>
            </Tooltip>
          ) : (
            newButton
          )
        }
      />

      {templatesQuery.isPending ? (
        <TableCard className="p-4">
          <SkeletonTableRows rows={6} />
        </TableCard>
      ) : templatesQuery.isError ? (
        <QueryError
          error={templatesQuery.error}
          fallback="Failed to load templates"
          onRetry={() => void templatesQuery.refetch()}
          isRetrying={templatesQuery.isFetching}
        />
      ) : (
        <ReportTemplatesList
          templates={templatesQuery.data?.templates ?? []}
          canGenerate={canGenerate}
          onEdit={(template) => setForm({ template })}
          onDelete={setPendingDelete}
          onGenerate={setGenerateFor}
        />
      )}

      {form ? (
        <ReportTemplateForm
          brandKey={brandKey}
          template={form.template}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            invalidate();
          }}
        />
      ) : null}

      {pendingDelete ? (
        <ConfirmDialog
          title={`Delete \u201c${pendingDelete.name}\u201d?`}
          confirmLabel="Delete template"
          destructive
          pending={deleteMutation.isPending}
          onClose={() => setPendingDelete(null)}
          onConfirm={() => deleteMutation.mutate(pendingDelete.id)}
        >
          Reports already written from it are not affected.
        </ConfirmDialog>
      ) : null}

      {generateFor ? (
        <GenerateReportDialog
          brandKey={brandKey}
          initialTemplateId={generateFor.id}
          onClose={() => setGenerateFor(null)}
        />
      ) : null}
    </div>
  );
}
