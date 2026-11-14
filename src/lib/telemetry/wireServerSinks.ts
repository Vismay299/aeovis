import { setServerErrorReporter } from "./reporters.ts";
import { captureServerError } from "./server.ts";

/** Wire F01 error hooks to the F26 server capture. Called once from instrumentation. */
export function wireServerSinks(): void {
  setServerErrorReporter((err, props) => {
    void captureServerError(err, props as { route?: string; job_kind?: string; error_code?: string });
  });
}
