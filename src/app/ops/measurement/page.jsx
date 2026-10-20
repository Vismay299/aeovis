"use client";
import { useEffect, useState } from "react";
export default function MeasurementOperations() {
  const [data, setData] = useState(null),
    [error, setError] = useState("");
  async function load() {
    setError("");
    try {
      const r = await fetch("/api/measurement/operations", {
        cache: "no-store",
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.error || "Could not load operations");
      setData(d);
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    load();
  }, []);
  async function acknowledge(id) {
    try {
      const r = await fetch("/api/measurement/operations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ incident_id: id, action: "acknowledge" }),
      });
      if (!r.ok) throw Error("Acknowledgement failed");
      await load();
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <main style={{ padding: 32, maxWidth: 1200, margin: "auto" }}>
      <h1>Measurement operations</h1>
      <button onClick={load}>Refresh stored status</button>
      {error ? (
        <p role="alert">{error}</p>
      ) : !data ? (
        <p role="status">Loading stored measurements…</p>
      ) : (
        <>
          <h2>Provider readiness</h2>
          <p>
            Stored canaries only. Refreshing this page sends no provider
            requests.
          </p>
          <pre style={{ whiteSpace: "pre-wrap" }}>
            {JSON.stringify(data.readiness, null, 2)}
          </pre>
          <h2>Collection incidents</h2>
          {data.incidents.length === 0 ? (
            <p>No recorded incidents.</p>
          ) : (
            data.incidents.map((i) => (
              <article key={i.id}>
                <h3>
                  {i.engine}: {i.kind}
                </h3>
                <p>
                  Parser {i.parser_version} · First {i.first_seen} · Last{" "}
                  {i.last_seen} · {i.occurrences} captures
                </p>
                <p>
                  Investigate the retained response and update parser fixtures
                  before restoring qualification.
                </p>
                {i.acknowledged_at ? (
                  <p>Acknowledged {i.acknowledged_at}</p>
                ) : (
                  <button onClick={() => acknowledge(i.id)}>Acknowledge</button>
                )}
              </article>
            ))
          )}
          <h2>Observations needing attention</h2>
          <table>
            <thead>
              <tr>
                <th>Surface</th>
                <th>Disposition</th>
                <th>Attempts</th>
                <th>Cost uncertainty</th>
                <th>Recovery</th>
              </tr>
            </thead>
            <tbody>
              {data.observations.map((o) => (
                <tr key={o.id}>
                  <td>{o.engine}</td>
                  <td>
                    {o.state}: {o.reason}
                  </td>
                  <td>{o.attempt_count}</td>
                  <td>
                    {o.unknown_cost_calls} calls · measured ${o.total_cost}
                  </td>
                  <td>
                    {o.state === "ambiguous"
                      ? "Reconcile the provider receipt before authorizing another call"
                      : o.state === "retry"
                        ? `Due ${o.next_attempt_at}`
                        : "Resolve configuration or collection failure before retrying"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2>Scheduled opportunities</h2>
          <table>
            <thead>
              <tr>
                <th>Workspace</th>
                <th>Due</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {data.windows.map((w) => (
                <tr key={`${w.brand}:${w.window_at}`}>
                  <td>{w.brand}</td>
                  <td>{w.window_at}</td>
                  <td>
                    {w.disposition} {w.reason}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
