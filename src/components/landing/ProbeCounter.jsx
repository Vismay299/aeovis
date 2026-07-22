"use client";

import { useEffect, useState } from "react";

const BASE = 37720;

export const ProbeCounter = () => {
  const [count, setCount] = useState(BASE);

  useEffect(() => {
    const interval = setInterval(() => {
      const inc = Math.floor(Math.random() * 3) + 1;
      setCount((c) => c + inc);
    }, 2200);
    return () => clearInterval(interval);
  }, []);

  return <div className="lp-stat-value">{count.toLocaleString()}</div>;
};
