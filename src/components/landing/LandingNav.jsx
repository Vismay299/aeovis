"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Wordmark } from "@/components/perceev/Wordmark";
import { Button } from "@/components/perceev/Button";
import { saveScan } from "@/services/api";
import { SAMPLE_RESULT } from "@/data/mockData";

export const LandingNav = () => {
  const router = useRouter();

  const scrollTo = (id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const viewSample = () => {
    saveScan({ ...SAMPLE_RESULT, isSample: true });
    router.push("/dashboard");
  };

  return (
    <header className="lp-nav">
      <div className="lp-container lp-nav-inner">
        <Link
          href="/"
          aria-label="Perceev home"
          style={{ display: "inline-flex" }}
          onClick={(e) => {
            e.preventDefault();
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
        >
          <Wordmark size="default" />
        </Link>
        <div className="lp-nav-links">
          <button className="lp-nav-link" onClick={() => scrollTo("how-it-works")}>
            How it works
          </button>
          <button className="lp-nav-link" onClick={viewSample}>
            Sample report
          </button>
          <Button variant="primary" size="md" onClick={() => router.push("/scan")}>
            Run the count
          </Button>
        </div>
      </div>
    </header>
  );
};
