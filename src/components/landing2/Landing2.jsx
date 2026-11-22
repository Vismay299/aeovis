"use client";

import { useEffect, useState } from "react";
import { PerceevLoader } from "@/components/app/brand/PerceevLogo";
import "./landing2.css";

import { ScrollTrigger, registerGsap, prefersReducedMotion } from "./motion";
import Nav from "./Nav";
import Hero from "./Hero";
import QuestionBand from "./QuestionBand";
import Shift from "./Shift";
import Unbranded from "./Unbranded";
import Sorting from "./Sorting";
import Verdict from "./Verdict";
import Evidence from "./Evidence";
import Studio from "./Studio";
import Faq from "./Faq";
import FinalCta from "./FinalCta";
import Footer from "./Footer";

export default function Landing2() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    registerGsap();

    /*
     * Native scrolling, on purpose. A JS smooth-scroller (Lenis, tried first)
     * moves the page from the main thread every frame, so the hero's WebGL
     * work made the scroll itself stutter and trail the wheel by seconds.
     * The browser's own scroll runs on the compositor thread and cannot be
     * held up by anything the page draws. ScrollTrigger reads it directly.
     */
    const smooth = !prefersReducedMotion();

    /* In-page anchors glide (or jump, under reduced motion). */
    const onClick = (event) => {
      const link = event.target.closest("a[href^=\"#\"]");
      if (!link) return;
      const id = link.getAttribute("href");
      if (id.length < 2) return;
      const target = document.querySelector(id);
      if (!target) return;
      event.preventDefault();
      const top = target.getBoundingClientRect().top + window.scrollY - 24;
      window.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
    };
    document.addEventListener("click", onClick);

    let active = true;
    const reveal = async () => {
      await document.fonts?.ready;
      if (!active) return;
      ScrollTrigger.refresh();
      setReady(true);
    };
    if (document.readyState === "complete") reveal();
    else window.addEventListener("load", reveal, { once: true });

    return () => {
      document.removeEventListener("click", onClick);
      active = false;
      window.removeEventListener("load", reveal);
    };
  }, []);

  return (
    <div className="lp2" data-loading={ready ? undefined : ""}>
      {!ready && (
        <div className="lp2-loader">
          <PerceevLoader label="Loading Perceev" />
        </div>
      )}
      <Nav />
      <main id="main">
        <Hero ready={ready} />
        <QuestionBand />
        <Shift />
        <Unbranded />
        <Sorting />
        <Verdict />
        <Evidence />
        <Studio />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
