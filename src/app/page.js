import Landing2 from "@/components/landing2/Landing2";

// PERCEEV home page, built in src/components/landing2. Every figure derives from
// the sample report (landing2/sample.js); landingProbeCounter and landingHonesty guard it.
// THE PROBE COUNTER, AND WHY THERE ISN'T ONE: no lifetime total is claimed here. One
// must read a real count query and show an em dash plus a state chip when it cannot.

export default function Home() {
  return <Landing2 />;
}
