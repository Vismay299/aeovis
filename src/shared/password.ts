// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/auth/passwordSchema.ts
//   src/routes/_auth.sign-up.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";

// Perceev's existing sign-up rule (src/app/signup/page.jsx); OpenSEO uses 8.
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`);

// From openseo:src/routes/_auth.sign-up.tsx.
export const signUpSchema = z
  .object({
    email: z.string().trim().email("Enter a valid email address."),
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });
