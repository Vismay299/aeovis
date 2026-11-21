"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import Magnet from "@/components/reactbits/Magnet";
import { useInView } from "./motion";

/**
 * The one ask on the page: a domain. It hands the domain to /scan through the
 * same `perceev_prescan_domain` key the scan page already reads on mount, and
 * the scan page asks for the rest.
 */
export default function ScanForm({ size = "lg", testId }) {
  const router = useRouter();
  const id = useId();
  const [site, setSite] = useState("");
  const [error, setError] = useState("");
  const formRef = useRef(null);
  const inView = useInView(formRef, "0px");

  const submit = (event) => {
    event.preventDefault();
    const value = site.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (value && !/^([\w-]+\.)+[\w-]{2,}$/.test(value)) {
      setError("That does not look like a domain. Try acme.com");
      return;
    }
    setError("");
    if (value) {
      try {
        localStorage.setItem("perceev_prescan_domain", value);
      } catch {
        /* storage blocked: the scan page simply starts with an empty field */
      }
    }
    router.push("/scan");
  };

  return (
    <form ref={formRef} className={`lp2-scan lp2-scan--${size}`} onSubmit={submit} noValidate data-testid={testId}>
      <div className="lp2-scan__field">
        <label htmlFor={id} className="lp2-sr">Your website</label>
        <span className="lp2-scan__prefix" aria-hidden="true">https://</span>
        <input
          id={id}
          type="text"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          placeholder="yourcompany.com"
          value={site}
          onChange={(e) => setSite(e.target.value)}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
        />
        <Magnet padding={40} magnetStrength={6} wrapperClassName="lp2-scan__magnet">
          <button type="submit" className="lp2-btn">
            <span>Run free scan</span>
            <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </Magnet>
        <span className="lp2-beam" data-on={inView ? "true" : "false"} aria-hidden="true" />
      </div>
      {error ? (
        <p id={`${id}-err`} className="lp2-scan__err" role="alert">{error}</p>
      ) : null}
    </form>
  );
}
