"use client";

import { createRef, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Zap, Search, LineChart, PenLine, UserCheck, Upload } from "lucide-react";
import { AnimatedBeam } from "@/components/magicui/animated-beam";
import { useGsap, gsap } from "./motion";

/* The content run as the Studio canvas draws it: one trigger, three agents,
   one person, one hand-off. Copy follows src/components/studio/AgentCanvas.jsx. */
const NODES = [
  { key: "gap", title: "Gap detected", role: "Trigger", icon: Zap, detail: "A run starts from an answer a rival holds, not from a content calendar. Nothing gets written about a question no engine was asked." },
  { key: "research", title: "Researcher", role: "Agent", icon: Search, detail: "Reads every source the engines cited for that question, plus the rival page that is winning it, and pulls out what the answer rewards." },
  { key: "strategy", title: "Strategist", role: "Agent", icon: LineChart, detail: "Chooses the angle. Every rival-held answer organises itself around something; the strategist names it and rejects the rest." },
  { key: "write", title: "Writer", role: "Agent", icon: PenLine, detail: "Drafts against the chosen angle with the cited sources in context, and never states a claim it cannot attribute to something the researcher read." },
  { key: "you", title: "Editor", role: "You", icon: UserCheck, detail: "The one step no agent can take. Approve the draft, or send it back with a note and the writer picks it up again. Nothing ships without you." },
  { key: "ship", title: "Export & measure", role: "Hand-off", icon: Upload, detail: "Export the approved draft and publish it on your site. The next scan asks the same questions, so you can see whether the answer moved." },
];

const CADENCE = [
  { k: "Every 72 hours", v: "Default" },
  { k: "Daily", v: "For launches" },
  { k: "Weekly", v: "For steady state" },
];

export default function Studio() {
  const root = useRef(null);
  const container = useRef(null);
  const refs = useMemo(() => NODES.map(() => createRef()), []);
  const [active, setActive] = useState("you");
  const node = NODES.find((n) => n.key === active);

  useGsap(root, ({ reduced }) => {
    if (reduced) return;
    gsap.from(".lp2-studio__head > *", {
      opacity: 0, y: 24, stagger: 0.08, duration: 1, ease: "power3.out",
      scrollTrigger: { trigger: root.current, start: "top 70%" },
    });
    gsap.from(".lp2-node", {
      opacity: 0, y: 40, scale: 0.94, stagger: 0.09, duration: 1, ease: "expo.out",
      scrollTrigger: { trigger: ".lp2-flow", start: "top 80%" },
    });
    gsap.from(".lp2-cadence__item", {
      opacity: 0, y: 20, stagger: 0.08, duration: 0.8, ease: "power3.out",
      scrollTrigger: { trigger: ".lp2-cadence", start: "top 85%" },
    });
  });

  return (
    <section ref={root} id="studio" className="lp2-studio lp2-section" aria-labelledby="lp2-studio-title">
      <div className="lp2-wrap">
        <div className="lp2-studio__head">
          <p className="lp2-eyebrow">Content Studio</p>
          <h2 id="lp2-studio-title" className="lp2-h2">
            Then close the gap.<br /><span className="lp2-dim">Agents do the work. You make the call.</span>
          </h2>
          <p className="lp2-lede">
            Every answer a rival holds becomes an opportunity. Agents research it, plan the angle and draft the
            page. You approve, and approving never means publishing on its own.
          </p>
        </div>

        <div className="lp2-flow" ref={container}>
          {NODES.map((n, i) => {
            const Icon = n.icon;
            return (
              <button
                key={n.key}
                ref={refs[i]}
                type="button"
                className="lp2-node"
                data-key={n.key}
                data-active={active === n.key ? "true" : "false"}
                onClick={() => setActive(n.key)}
                onMouseEnter={() => setActive(n.key)}
                aria-pressed={active === n.key}
              >
                <span className="lp2-node__icon"><Icon size={18} strokeWidth={1.6} aria-hidden="true" /></span>
                <span className="lp2-node__role">{n.role}</span>
                <span className="lp2-node__title">{n.title}</span>
              </button>
            );
          })}

          {NODES.slice(0, -1).map((n, i) => (
            <AnimatedBeam
              key={`beam-${n.key}`}
              containerRef={container}
              fromRef={refs[i]}
              toRef={refs[i + 1]}
              duration={3.2}
              delay={i * 0.35}
              pathColor="rgba(255,255,255,0.5)"
              pathOpacity={0.22}
              pathWidth={1.5}
              gradientStartColor="#ffffff"
              gradientStopColor="rgba(255,255,255,0.15)"
            />
          ))}
          {/* Sent back with a note: the editor returns a draft to the writer. */}
          <AnimatedBeam
            containerRef={container}
            fromRef={refs[4]}
            toRef={refs[3]}
            curvature={75}
            reverse
            duration={4.5}
            delay={1.2}
            pathColor="rgba(255,255,255,0.4)"
            pathOpacity={0.1}
            pathWidth={1}
            gradientStartColor="rgba(255,255,255,0.7)"
            gradientStopColor="rgba(255,255,255,0.05)"
          />
          <span className="lp2-flow__return" aria-hidden="true">send back with a note</span>
        </div>

        <div className="lp2-flow__detail" aria-live="polite">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={node.key}
              initial={{ opacity: 0, y: 10, filter: "blur(6px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -8, filter: "blur(6px)" }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              className="lp2-flow__detailinner"
            >
              <span className="lp2-chip lp2-chip--ghost">{node.role}</span>
              <strong>{node.title}</strong>
              <p>{node.detail}</p>
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="lp2-cadence">
          <div className="lp2-cadence__copy">
            <h3 className="lp2-h3">And it keeps asking.</h3>
            <p className="lp2-muted">
              Scans recur on a schedule per brand, so you can see whether a page you published actually moved the
              answer. Your tracked question set only ever grows, which keeps every reading comparable with the last.
            </p>
          </div>
          <ul className="lp2-cadence__list">
            {CADENCE.map((c) => (
              <li key={c.k} className="lp2-cadence__item">
                <span className="lp2-cadence__pulse" aria-hidden="true" />
                <strong>{c.k}</strong>
                <span>{c.v}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
