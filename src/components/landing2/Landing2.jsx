"use client";

import { useEffect } from "react";
import Lenis from "lenis";
import "lenis/dist/lenis.css";
import "./landing2.css";

import { gsap, ScrollTrigger, registerGsap, prefersReducedMotion } from "./motion";
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
  useEffect(() => {
    registerGsap();
    if (prefersReducedMotion()) return undefined;

    const lenis = new Lenis({ lerp: 0.085, wheelMultiplier: 0.9, smoothWheel: true });
    lenis.on("scroll", ScrollTrigger.update);
    const tick = (time) => lenis.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);

    /* In-page anchors go through Lenis so they glide instead of jumping. */
    const onClick = (event) => {
      const link = event.target.closest("a[href^=\"#\"]");
      if (!link) return;
      const id = link.getAttribute("href");
      if (id.length < 2) return;
      const target = document.querySelector(id);
      if (!target) return;
      event.preventDefault();
      lenis.scrollTo(target, { offset: -24, duration: 1.4 });
    };
    document.addEventListener("click", onClick);

    /* Fonts and the WebGL canvases change layout after first paint. */
    const refresh = () => ScrollTrigger.refresh();
    document.fonts?.ready.then(refresh);
    window.addEventListener("load", refresh);

    return () => {
      document.removeEventListener("click", onClick);
      window.removeEventListener("load", refresh);
      gsap.ticker.remove(tick);
      lenis.destroy();
    };
  }, []);

  return (
    <div className="lp2">
      <Nav />
      <main id="main">
        <Hero />
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
