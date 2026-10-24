import type { ZodType } from "zod";

export type RouteContract = {
  id: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  file: string;
  auth: "workspace" | "workspace_owner" | "cron" | "operator";
  request?: ZodType;
  query?: ZodType;
  response: ZodType;
  errorCodes: string[];
  examples: { response: unknown }[];
};

// id -> route signature. A dev-server HMR reload re-evaluates a contract module
// without unloading this one, so an identical re-registration is allowed; a
// second file claiming the same id with a different route is not.
const registered = new Map<string, string>();

function signature(contract: RouteContract): string {
  return `${contract.method} ${contract.path} ${contract.file}`;
}

export function defineRouteContract(contract: RouteContract): RouteContract {
  const key = contract.id;
  const existing = registered.get(key);
  const next = signature(contract);
  if (existing !== undefined && existing !== next) {
    throw new Error(`Duplicate route contract id: ${key}`);
  }
  registered.set(key, next);
  return contract;
}
