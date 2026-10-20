import pg from "pg";
const client = new pg.Client();
await client.connect();
await client.query("SELECT claim_probe_dispatch($1,0.1,10,NULL,120)", [
  process.argv[2],
]);
process.send({ phase: "provider_returned_before_commit" });
// Keep the child alive until the parent kills it at this exact boundary.
setInterval(() => {}, 1000);
