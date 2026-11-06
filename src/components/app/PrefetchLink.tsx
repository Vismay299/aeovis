"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/router.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useCallback, useRef, type ComponentProps } from "react";
import Link from "next/link";
import { useQueryClient, type FetchQueryOptions } from "@tanstack/react-query";

export type PrefetchLinkProps = ComponentProps<typeof Link> & {
  prefetch?: () => FetchQueryOptions<any, any, any, any>;
};

export function PrefetchLink({
  prefetch,
  onMouseEnter,
  onFocus,
  onTouchStart,
  ...props
}: PrefetchLinkProps) {
  const queryClient = useQueryClient();
  const prefetchedRef = useRef(false);

  const triggerPrefetch = useCallback(() => {
    if (!prefetch || prefetchedRef.current) return;
    prefetchedRef.current = true;
    try {
      const options = prefetch();
      if (options) {
        void queryClient.prefetchQuery(options);
      }
    } catch {
      // Ignore prefetch errors
    }
  }, [prefetch, queryClient]);

  const handleMouseEnter = (e: React.MouseEvent<HTMLAnchorElement>) => {
    triggerPrefetch();
    onMouseEnter?.(e);
  };

  const handleFocus = (e: React.FocusEvent<HTMLAnchorElement>) => {
    triggerPrefetch();
    onFocus?.(e);
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLAnchorElement>) => {
    triggerPrefetch();
    onTouchStart?.(e);
  };

  return (
    <Link
      {...props}
      onMouseEnter={handleMouseEnter}
      onFocus={handleFocus}
      onTouchStart={handleTouchStart}
    />
  );
}
