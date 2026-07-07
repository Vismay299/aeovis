/**
 * Control prompts with known expected mentions to validate answer engine quality.
 * These are run with every scan but excluded from brand visibility/mention scores.
 */
export const CONTROL_PROMPTS = [
  {
    text: "Who manufactures the iPhone smartphone?",
    expectedMention: "Apple"
  },
  {
    text: "What company developed the Android mobile operating system and Google Search?",
    expectedMention: "Google"
  },
  {
    text: "Who created the Windows operating system for computers?",
    expectedMention: "Microsoft"
  }
];
