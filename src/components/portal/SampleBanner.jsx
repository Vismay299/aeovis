"use client";

import { FlaskConical } from "lucide-react";
import { AppBanner } from "@/components/app/AppBanner";
import { Button } from "@/components/ui/button";

/**
 * Shown on every page of the sample workspace. Brightwave is fictional and
 * every figure is invented, so the banner says so wherever a figure appears,
 * and offers the two ways out: sign up, or leave.
 */
export function SampleBanner() {
  return (
    <AppBanner variant="info" icon={<FlaskConical className="size-4" />}>
      <span className="mr-2" data-testid="sample-banner">
        <b className="font-medium">Sample workspace.</b> Brightwave and its rivals are fictional and every number is
        invented, to show what Perceev does. Nothing here is saved or run.
      </span>
      <span className="inline-flex gap-2">
        <Button size="xs" nativeButton={false} render={<a href="/sample/exit?to=/signup" />}>
          Sign up free
        </Button>
        <Button size="xs" variant="outline" nativeButton={false} render={<a href="/sample/exit" />}>
          Exit sample
        </Button>
      </span>
    </AppBanner>
  );
}

export default SampleBanner;
