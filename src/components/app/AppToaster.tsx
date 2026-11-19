"use client";

import { Toaster } from "sonner";
import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import { Spinner, SuccessCheck } from "@/components/ui/spinner";

/**
 * The app's toasts. Their look comes from the scheme and shape tokens in
 * src/styles/shapes.css, so there is one toaster for every surface. A success
 * draws its tick and a loading toast carries the app spinner.
 */
export function AppToaster() {
  return (
    <Toaster
      theme="dark"
      position="bottom-right"
      mobileOffset={{ bottom: 100 }}
      gap={10}
      icons={{
        success: <SuccessCheck />,
        loading: <Spinner />,
        error: <CircleAlert />,
        warning: <TriangleAlert />,
        info: <Info />,
      }}
    />
  );
}

export default AppToaster;
