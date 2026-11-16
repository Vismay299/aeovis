import type { Workspace } from "../../workspace/requireWorkspace.ts";
import type { ToolHandlerContext } from "../types.ts";

/** Build F01's Workspace for services that take one, binding the tool's brand. */
export function toWorkspace(ctx: ToolHandlerContext): Workspace {
  return {
    user: ctx.user,
    brandKey: ctx.brand.brandKey,
    brand: ctx.brand,
    role: ctx.role,
    admin: ctx.admin,
  };
}
