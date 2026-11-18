// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/reports/ReportTemplateForm.tsx:18-150
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

// One form for create and edit. Shape only, as at every other boundary: the
// caps come back from the service with their copy and show in a toast.
//
// NOTE (F23 Phase 4, GAP-3): OpenSEO builds this form with TanStack Form
// (`useAppForm`). The Perceev repo has no TanStack Form dependency and no
// `useAppForm` primitive, so this port uses controlled inputs with the same
// trimmed client validation and OpenSEO's messages instead of adding a new
// form library for one dialog.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fetchJson } from "@/shared/query/fetchJson";
import { describeError } from "@/shared/query/errors";
import { trackEvent } from "@/shared/telemetry/client";
import type { ReportTemplateItem } from "./hooks/useReports.ts";

const INSTRUCTIONS_PLACEHOLDER = `Audience: the client's marketing lead, not technical.
Sections, in order: Where we are / What we did this month / What moved in AI answers / What to expect next.
Tone: plain and confident. Explain every term. No exclamation points.
Sign off as: Acme Studio
Accent: #3730CE`;

function validate(values: { name: string; description: string; instructions: string }) {
  const errors: { name?: string; description?: string; instructions?: string } = {};
  if (values.name.trim() === "") {
    errors.name = "Give the template a name.";
  }
  if (values.description.trim() === "") {
    errors.description = "Say in one line when to use this template.";
  }
  if (values.instructions.trim() === "") {
    errors.instructions = "Say who the report is for and which sections it has.";
  }
  return errors;
}

export function ReportTemplateForm({
  brandKey,
  template,
  onClose,
  onSaved,
}: {
  brandKey: string;
  /** The template being edited, or undefined when creating one. */
  template?: ReportTemplateItem;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [instructions, setInstructions] = useState(template?.instructions ?? "");
  const [errors, setErrors] = useState<{
    name?: string;
    description?: string;
    instructions?: string;
  }>({});

  const saveMutation = useMutation({
    // A refusal (duplicate name, the cap) carries its copy in the error body,
    // so the shared error toast stays off and the message shows in a toast.
    meta: { errorToast: false },
    mutationFn: async (values: {
      name: string;
      description: string;
      instructions: string;
    }) => {
      const body = { brand_key: brandKey, ...values };
      if (template) {
        return fetchJson<{ templateId: string; created: false }>(
          `/api/customer/reports/templates/${encodeURIComponent(template.id)}`,
          { method: "PUT", body },
        );
      }
      return fetchJson<{ templateId: string; created: boolean }>(
        "/api/customer/reports/templates",
        { method: "POST", body },
      );
    },
    onSuccess: (result) => {
      const isUpdate = template !== undefined || result.created === false;
      trackEvent("report_template:saved", { is_update: isUpdate });
      toast.success(result.created ? "Template created" : "Template saved");
      onSaved();
    },
    onError: (error) => {
      toast.error(describeError(error, "Could not save this template."));
    },
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const nextErrors = validate({ name, description, instructions });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    void saveMutation.mutateAsync({
      name: name.trim(),
      description: description.trim(),
      instructions: instructions.trim(),
    });
  };

  const pending = saveMutation.isPending;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        fullScreenOnMobile
        className="sm:max-w-2xl"
      >
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{template ? "Edit template" : "New template"}</DialogTitle>
          </DialogHeader>

          <Field>
            <FieldLabel htmlFor="report-template-name">Name</FieldLabel>
            <Input
              id="report-template-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Monthly client check-in"
              required
              disabled={pending}
              aria-invalid={errors.name ? true : undefined}
            />
            {errors.name ? <FieldError>{errors.name}</FieldError> : null}
          </Field>

          <Field>
            <FieldLabel htmlFor="report-template-description">
              Description
            </FieldLabel>
            <FieldDescription>
              One line saying when to use it. This is what the assistant reads
              to decide.
            </FieldDescription>
            <Input
              id="report-template-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="The monthly update we send retainer clients."
              required
              disabled={pending}
              aria-invalid={errors.description ? true : undefined}
            />
            {errors.description ? (
              <FieldError>{errors.description}</FieldError>
            ) : null}
          </Field>

          <Field>
            <FieldLabel htmlFor="report-template-instructions">
              Instructions
            </FieldLabel>
            <FieldDescription>
              Brand voice for the whole workspace lives in Context › Writing
              preferences.
            </FieldDescription>
            <Textarea
              id="report-template-instructions"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              className="h-56 font-mono md:text-xs"
              placeholder={INSTRUCTIONS_PLACEHOLDER}
              required
              disabled={pending}
              aria-invalid={errors.instructions ? true : undefined}
            />
            {errors.instructions ? (
              <FieldError>{errors.instructions}</FieldError>
            ) : null}
          </Field>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" pending={pending}>
              {template ? "Save changes" : "Create template"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
