"use client";

/**
 * The moving threads from the home page's hero, behind the sign-in column.
 * Client only and loaded after the form, so the form never waits on WebGL.
 * A veil darkens the middle so the form always reads on plain onyx.
 */

import dynamic from "next/dynamic";

const Threads = dynamic(() => import("@/components/reactbits/Threads"), { ssr: false });

export default function AuthBackdrop({ className = "" }) {
  return (
    <div className={`auth-backdrop ${className}`.trim()} aria-hidden="true">
      <div className="auth-backdrop__threads">
        <Threads
          color={[0.96, 0.96, 0.97]}
          amplitude={1.1}
          distance={0.3}
          lineCount={30}
          maxRenderDim={1200}
          maxSegments={240}
          thickness={0.5}
          speed={0.3}
          brightness={0.85}
          opacity={0.5}
          angle={18}
          enableMouseInteraction
        />
      </div>
      <div className="auth-backdrop__veil" />
    </div>
  );
}
