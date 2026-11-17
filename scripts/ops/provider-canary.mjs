#!/usr/bin/env node
// Deliberate operator dispatch. Health reads never dispatch a provider call.
import { pathToFileURL } from "node:url";
import { dispatchCanaries } from "../../src/server/ops/providerCanary.js";
export { dispatchCanaries };

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((pairs, value, index, list) => {
      if (value.startsWith("--")) pairs.push([value.slice(2), list[index + 1]]);
      return pairs;
    }, []),
  );
  try {
    const result = await dispatchCanaries({
      engines: args.engines?.split(","),
      slot: args.slot,
      maxRequests: Number(args["max-requests"]),
      maxSpendUsd: Number(args["max-spend-usd"]),
      reserveUsd: Number(args["reserve-usd"]),
      route: args.route || undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.some((r) => !["answered", "valid_no_aio"].includes(r.state)))
      process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
