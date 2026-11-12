"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/domain/components/DomainPageLink.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { PageButtonProps } from "@/components/app/table/TablePagination";
import { buttonVariants } from "@/components/ui/button";

/** Prev/next as real links, so a page can open in a new tab. */
export function DomainPageLink({
  page,
  disabled,
  label,
  children,
  onPageChange,
}: PageButtonProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const nextParams = new URLSearchParams(searchParams ? searchParams.toString() : "");
  if (page <= 1) {
    nextParams.delete("page");
  } else {
    nextParams.set("page", String(page));
  }
  const href = `${pathname}?${nextParams.toString()}`;

  return (
    <Link
      href={href}
      aria-label={label}
      aria-disabled={disabled}
      className={buttonVariants({
        variant: "ghost",
        size: "icon-sm",
        className: disabled ? "pointer-events-none opacity-50" : undefined,
      })}
      onClick={(event) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        if (
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          event.button !== 0
        ) {
          return;
        }
        event.preventDefault();
        onPageChange(page);
      }}
    >
      {children}
    </Link>
  );
}
