"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/perceev/Button";

export const ScanBar = ({ className = "" }) => {
  const router = useRouter();
  const [domain, setDomain] = useState("");
  const [focused, setFocused] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (domain.trim()) {
      localStorage.setItem("perceev_prescan_domain", domain.trim());
    }
    router.push("/scan");
  };

  return (
    <form
      onSubmit={handleSubmit}
      className={`flex items-center gap-0 ${className}`}
      style={{
        background: "var(--bg-1)",
        border: `1px solid ${focused ? "var(--accent-border)" : "var(--border-2)"}`,
        borderRadius: "var(--radius-2)",
        overflow: "hidden",
        padding: "4px",
        transition: "border-color var(--dur-fast)",
        boxShadow: focused ? "0 0 0 3px var(--accent-soft)" : "none",
      }}
    >
      <input
        value={domain}
        onChange={(e) => setDomain(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="yourcompany.com"
        aria-label="Your website domain"
        style={{
          flex: 1,
          background: "transparent",
          border: "none",
          padding: "0 16px",
          fontFamily: "var(--font-sans)",
          fontSize: "15px",
          color: "var(--text-1)",
          outline: "none",
          minWidth: 0,
          height: "var(--control-h-lg)",
        }}
      />
      <Button
        variant="primary"
        size="lg"
        type="submit"
        style={{ flexShrink: 0, padding: "0 24px" }}
      >
        Run the count
      </Button>
    </form>
  );
};
