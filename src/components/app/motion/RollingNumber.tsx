"use client";

import * as React from "react";
import { cn } from "@/shared/utils";

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
const subscribeNever = () => () => {};

/**
 * A number whose digits roll to their value, each on its own reel.
 *
 * Pass the already-formatted text as children ("1,204", "38%"). Anything
 * without a digit renders untouched. A number present in the server HTML
 * appears in place; one that arrives later rolls up from zero, and every
 * later change rolls from the digit it was showing.
 */
export function RollingNumber({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const text =
    typeof children === "number" ? String(children) : typeof children === "string" ? children : null;
  // false on the server and while hydrating, true for anything mounted later
  const onClient = React.useSyncExternalStore(subscribeNever, () => true, () => false);
  const mountedLate = React.useRef(onClient).current;
  const [settled, setSettled] = React.useState(!mountedLate);

  React.useEffect(() => {
    if (settled) return;
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, [settled]);

  if (text === null || !onClient || !/\d/.test(text)) {
    return <>{children}</>;
  }

  const chars = Array.from(text);
  return (
    <span data-slot="number-roll" className={className}>
      <span className="sr-only">{text}</span>
      <span aria-hidden className="contents">
        {chars.map((char, index) => {
          const fromRight = chars.length - 1 - index;
          if (char < "0" || char > "9") {
            return <span key={`s${fromRight}`}>{char}</span>;
          }
          return (
            <span key={`d${fromRight}`} data-slot="number-digit">
              <span className="invisible">0</span>
              <span data-slot="number-window">
                <span
                  data-slot="number-reel"
                  style={
                    {
                      "--digit": settled ? Number(char) : 0,
                      "--delay": `${Math.min(fromRight, 6) * 45}ms`,
                    } as React.CSSProperties
                  }
                >
                  {DIGITS.map((digit) => (
                    <span key={digit}>{digit}</span>
                  ))}
                </span>
              </span>
            </span>
          );
        })}
      </span>
    </span>
  );
}

export default RollingNumber;
