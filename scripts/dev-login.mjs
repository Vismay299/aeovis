#!/usr/bin/env node
// Local sign-in without the captcha.
//
// Supabase Auth on this project requires a Turnstile token for email+password
// sign-in, and the Turnstile widget only allows the production hostname, so
// the login form cannot work on localhost. This script mints a one-time
// sign-in link with the service-role key (which skips the captcha) and opens it
// in the default browser. The link lands on the app's own /auth/callback, which
// sets the session cookie for localhost and redirects into the portal.
//
//   npm run dev:login                         # LOCAL_DEMO_EMAIL from .env.local
//   npm run dev:login -- you@example.com      # any existing account
//   npm run dev:login -- --next /portal/usage --port 3001
//   npm run dev:login -- --print              # print the link instead of opening it
//
// The link works once and expires after about an hour. It never creates an
// account: the email must already exist. It only targets localhost.

import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

function parseArgs(argv) {
  const out = { email: "", next: "/portal", port: "3000", print: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--print") out.print = true;
    else if (arg === "--next") out.next = argv[++i] ?? out.next;
    else if (arg === "--port") out.port = argv[++i] ?? out.port;
    else if (!arg.startsWith("--")) out.email = arg;
    else throw new Error(`Unknown option ${arg}`);
  }
  return out;
}

function fail(message) {
  console.error(`dev-login: ${message}`);
  process.exit(1);
}

function openInBrowser(url) {
  if (process.platform === "darwin") execFileSync("open", [url]);
  else if (process.platform === "win32") execFileSync("rundll32", ["url.dll,FileProtocolHandler", url]);
  else execFileSync("xdg-open", [url]);
}

async function findUser(admin, email) {
  const wanted = email.toLowerCase();
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((user) => user.email?.toLowerCase() === wanted);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

const args = parseArgs(process.argv.slice(2));
const email = (args.email || process.env.LOCAL_DEMO_EMAIL || "").trim();
if (!email) fail("pass an email, or set LOCAL_DEMO_EMAIL in .env.local");
if (!/^\d{2,5}$/.test(args.port)) fail("--port must be a number");
if (!args.next.startsWith("/") || args.next.startsWith("//")) fail("--next must be an app path such as /portal");

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) {
  fail("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (run via npm run dev:login)");
}

const admin = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const user = await findUser(admin, email);
if (!user) fail(`no account for ${email}; this script never creates one`);

const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
if (error) fail(error.message);

const link = new URL(`http://localhost:${args.port}/auth/callback`);
link.searchParams.set("token_hash", data.properties.hashed_token);
link.searchParams.set("type", "email");
link.searchParams.set("next", args.next);

if (args.print) {
  console.log(link.toString());
} else {
  openInBrowser(link.toString());
  console.log(`dev-login: opened a one-time sign-in link for ${email} (localhost:${args.port}${args.next})`);
}
