import Landing2 from "@/components/landing2/Landing2";

/*
 * Preview route for the redesigned landing page (branch landing-page-2).
 * It lives beside "/" rather than replacing it so both can be compared; it is
 * kept out of search indexes until it becomes the home page.
 */
export const metadata = {
  title: "Perceev | Is AI saying your name?",
  description:
    "Perceev asks answer engines the unbranded questions your buyers ask and shows, answer by answer, which brand gets named.",
  robots: { index: false, follow: false },
  alternates: { canonical: "/" },
};

export default function LandingTwoPage() {
  return <Landing2 />;
}
