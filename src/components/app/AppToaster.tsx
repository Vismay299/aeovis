"use client";

import { usePathname } from "next/navigation";
import { Toaster } from "sonner";
import { surfaceForPath } from "@/shared/theme/theme";
import { useThemePreference } from "@/components/app/theme/useThemePreference";

const LEGACY_TOAST_STYLE = {
  background: "var(--surface)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-md)",
  color: "var(--ink-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "14px",
  boxShadow: "var(--shadow-2)",
};

export function AppToaster() {
  const pathname = usePathname();
  const { resolvedTheme } = useThemePreference();
  const { surface } = surfaceForPath(pathname || "/");

  if (surface === "app") {
    return (
      <Toaster
        theme={resolvedTheme}
        position="bottom-right"
        mobileOffset={{ bottom: 100 }}
      />
    );
  }

  return (
    <Toaster
      theme="light"
      position="bottom-right"
      mobileOffset={{ bottom: 100 }}
      toastOptions={{
        style: LEGACY_TOAST_STYLE,
      }}
    />
  );
}

export default AppToaster;
