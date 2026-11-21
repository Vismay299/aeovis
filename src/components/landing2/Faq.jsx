"use client";

import { useId, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Plus } from "lucide-react";
import { QUESTION_COUNT, ENGINE_SENTENCE_LIST, ENGINE_NAMES } from "./sample";

const ITEMS = [
  {
    q: "What does the free scan actually do?",
    a: `It sources ${QUESTION_COUNT} questions a buyer in your category would ask, none of which mention you, and puts each one to ${ENGINE_SENTENCE_LIST}. Every answer is scored for whether you are named, whether you are cited, and which rivals are named instead.`,
  },
  {
    q: "Which answer engines do you ask?",
    a: `This deployment asks ${ENGINE_SENTENCE_LIST}. The report only ever shows engines that actually returned answers, so ${ENGINE_NAMES.length === 1 ? "it has a single engine column" : "every engine column is a real reading"}.`,
  },
  {
    q: "Why not just ask about my brand directly?",
    a: "Because a question with your name in it gets an answer with your name in it. That tells you nothing about what a buyer hears before they know you exist, which is the moment that decides the shortlist.",
  },
  {
    q: "How long does a scan take?",
    a: "It depends on how many engines are enabled. Progress is reported live while it runs, and if the run is interrupted it picks up where it stopped.",
  },
  {
    q: "Do the agents publish content for me?",
    a: "No. Agents research, plan and draft. You approve or send a draft back, then export and publish it yourself. Approval never triggers publishing.",
  },
  {
    q: "Are the brands on this page real?",
    a: "No. Brightwave, NorthPeak and Lumen IQ are fictional, and every figure here comes from one sample report so the numbers never contradict each other. Your scan shows your own brand and your real rivals.",
  },
];

function Item({ item, open, onToggle }) {
  const id = useId();
  return (
    <li className="lp2-faq__item" data-open={open ? "true" : "false"}>
      <h3>
        <button type="button" aria-expanded={open} aria-controls={id} onClick={onToggle} className="lp2-faq__btn">
          <span>{item.q}</span>
          <Plus size={18} aria-hidden="true" className="lp2-faq__icon" />
        </button>
      </h3>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            id={id}
            key="a"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className="lp2-faq__a"
          >
            <p>{item.a}</p>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  );
}

export default function Faq() {
  const [open, setOpen] = useState(0);
  return (
    <section className="lp2-faq lp2-section" aria-labelledby="lp2-faq-title">
      <div className="lp2-wrap lp2-faq__grid">
        <div>
          <p className="lp2-eyebrow">Questions</p>
          <h2 id="lp2-faq-title" className="lp2-h2">Straight answers.</h2>
          <p className="lp2-lede">How the scan works, what it measures, and what it never does.</p>
        </div>
        <ul className="lp2-faq__list">
          {ITEMS.map((item, i) => (
            <Item key={item.q} item={item} open={open === i} onToggle={() => setOpen(open === i ? -1 : i)} />
          ))}
        </ul>
      </div>
    </section>
  );
}
