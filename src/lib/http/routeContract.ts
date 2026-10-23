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

const registeredIds = new Set<string>();

export function defineRouteContract(contract: RouteContract): RouteContract {
  if (registeredIds.has(contract.id)) {
    throw new Error(`Duplicate route contract id: ${contract.id}`);
  }
  registeredIds.add(contract.id);
  return contract;
}
