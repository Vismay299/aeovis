"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/domain/components/SaveDomainKeywordsDialog.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FormDialog } from "@/components/app/FormDialog";
import { HelpLabel } from "@/components/app/HelpLabel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchJson } from "@/lib/query/fetchJson";
import { describeError } from "@/lib/query/errors";
import { trackDomainEvent } from "./telemetry";

type Props = {
  brandKey: string;
  keywords: string[];
  /** The shown market's codes; never the form's, which may not match. */
  locationCode: number;
  languageCode: string;
  onClose: () => void;
};

export type SaveDomainKeywordsResponse = {
  savedKeywordIds: string[];
  created: number;
};

/**
 * Saves selected domain keywords to F13's saved list with the shown market.
 * Metrics are never sent: the route rejects a client `metrics` key.
 */
export function SaveDomainKeywordsDialog({
  brandKey,
  keywords,
  locationCode,
  languageCode,
  onClose,
}: Props) {
  const router = useRouter();
  const tagsId = useId();
  const [tags, setTags] = useState("");
  const [pending, setPending] = useState(false);

  const handleSave = async () => {
    setPending(true);
    try {
      const result = await fetchJson<SaveDomainKeywordsResponse>(
        "/api/customer/keywords/saved",
        {
          method: "POST",
          body: {
            brand_key: brandKey,
            keywords,
            locationCode,
            languageCode,
            tags: tags
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean),
            tagMode: "append",
          },
        },
      );
      trackDomainEvent("keyword:save", {
        source_feature: "domain_overview",
        keyword_count: keywords.length,
      });
      toast.success(`Saved ${result.created} keywords`, {
        action: {
          label: "Open saved keywords",
          onClick: () => router.push("/portal/keywords/saved"),
        },
      });
      onClose();
    } catch (error) {
      toast.error(
        describeError(error, "Could not save these keywords. Please retry."),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <FormDialog
      title={`Save ${keywords.length} keywords`}
      onClose={onClose}
      pending={pending}
      actions={
        <>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            pending={pending}
            onClick={() => void handleSave()}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-1.5 text-sm">
        <label
          htmlFor={tagsId}
          className="inline-flex items-center gap-1.5 font-medium"
        >
          <HelpLabel label="Tags" helpText="Added to every saved keyword." />
        </label>
        <Input
          id={tagsId}
          value={tags}
          placeholder="e.g. priority, blog"
          onChange={(event) => setTags(event.target.value)}
        />
      </div>
    </FormDialog>
  );
}
