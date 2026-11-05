// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/navigation/items.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * F04-AC-08 — the navigation model.
 *
 * Two registries are exercised: a synthetic one, so each rule is pinned on its
 * own, and the real registry, so the shipped items behave the way the shell
 * renders them.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  activeNavItemId,
  isItemActive,
  sectionPathForSwitch,
  visibleNavGroups,
} from "./navModel.ts";
import type { NavGroup, NavItem } from "./navModel.ts";
import { NAV_GROUPS } from "./items.ts";

function item(over: Partial<NavItem> & { id: string; href: string }): NavItem {
  return { label: over.id, ...over };
}

const GROUPS: NavGroup[] = [
  {
    id: "top",
    label: null,
    items: [item({ id: "overview", href: "/portal", match: "exact" })],
  },
  {
    id: "flags",
    label: "Flags",
    items: [
      item({ id: "flagged", href: "/portal/flagged", flag: "f" }),
      item({ id: "plain", href: "/portal/plain" }),
    ],
  },
  {
    id: "owners",
    label: "Owners",
    items: [item({ id: "team", href: "/portal/team", ownerOnly: true })],
  },
];

// --- flags -----------------------------------------------------------------

test("a flagged item is hidden while its flag is off", () => {
  const off = visibleNavGroups(GROUPS, { features: { f: false }, isOwner: true });
  assert.deepEqual(
    off.flatMap((group) => group.items.map((entry) => entry.id)),
    ["overview", "plain", "team"]
  );
});

test("a flagged item is hidden while the flags have not arrived", () => {
  const unknown = visibleNavGroups(GROUPS, { features: undefined, isOwner: true });
  assert.deepEqual(
    unknown.flatMap((group) => group.items.map((entry) => entry.id)),
    ["overview", "plain", "team"]
  );

  const nulled = visibleNavGroups(GROUPS, { features: null, isOwner: true });
  assert.deepEqual(
    nulled.flatMap((group) => group.items.map((entry) => entry.id)),
    ["overview", "plain", "team"]
  );
});

test("a flagged item is shown once its flag is on", () => {
  const on = visibleNavGroups(GROUPS, { features: { f: true }, isOwner: true });
  assert.deepEqual(
    on.flatMap((group) => group.items.map((entry) => entry.id)),
    ["overview", "flagged", "plain", "team"]
  );
});

// --- ownerOnly -------------------------------------------------------------

test("an owner-only item is hidden from a member", () => {
  const member = visibleNavGroups(GROUPS, { features: {}, isOwner: false });
  assert.deepEqual(
    member.flatMap((group) => group.items.map((entry) => entry.id)),
    ["overview", "plain"]
  );
});

test("an owner-only item is shown to an owner", () => {
  const owner = visibleNavGroups(GROUPS, { features: {}, isOwner: true });
  assert.ok(owner.flatMap((group) => group.items.map((entry) => entry.id)).includes("team"));
});

// --- empty groups ----------------------------------------------------------

test("a group whose items are all hidden is dropped", () => {
  const groups: NavGroup[] = [
    {
      id: "hidden",
      label: "Hidden",
      items: [item({ id: "only", href: "/portal/only", flag: "off" })],
    },
    {
      id: "kept",
      label: "Kept",
      items: [item({ id: "kept-item", href: "/portal/kept" })],
    },
  ];

  const visible = visibleNavGroups(groups, { features: { off: false }, isOwner: true });
  assert.deepEqual(
    visible.map((group) => group.id),
    ["kept"]
  );
});

test("an empty group is dropped", () => {
  const groups: NavGroup[] = [{ id: "empty", label: "Empty", items: [] }];
  assert.deepEqual(visibleNavGroups(groups, { features: {}, isOwner: true }), []);
});

// --- active ----------------------------------------------------------------

test("an exact item is active only on its own path", () => {
  const overview = GROUPS[0].items[0];
  assert.equal(isItemActive(overview, "/portal"), true);
  assert.equal(isItemActive(overview, "/portal/scans"), false);
  assert.equal(isItemActive(overview, "/portal/anything/deeper"), false);
});

test("a prefix item is active on its path and below it", () => {
  const scans = item({ id: "scans", href: "/portal/scans" });
  assert.equal(isItemActive(scans, "/portal/scans"), true);
  assert.equal(isItemActive(scans, "/portal/scans/abc"), true);
  assert.equal(isItemActive(scans, "/portal/scansomething"), false);
});

test("an active prefix lights an item whose href is elsewhere", () => {
  const questions = item({
    id: "questions",
    href: "/portal/measurement",
    activePrefixes: ["/portal/questions"],
  });
  assert.equal(isItemActive(questions, "/portal/questions/q1"), true);
  assert.equal(isItemActive(questions, "/portal/questions"), true);
  assert.equal(isItemActive(questions, "/portal/measurement"), true);
  assert.equal(isItemActive(questions, "/portal/other"), false);
});

// --- the real registry -----------------------------------------------------

test("the real registry: /portal is the Overview", () => {
  assert.equal(activeNavItemId(NAV_GROUPS, "/portal"), "overview");
});

test("the real registry: a scan report is the Scans item", () => {
  assert.equal(activeNavItemId(NAV_GROUPS, "/portal/scans/abc"), "scans");
  assert.equal(activeNavItemId(NAV_GROUPS, "/portal/scans"), "scans");
});

test("the real registry: a question is the Questions item", () => {
  assert.equal(activeNavItemId(NAV_GROUPS, "/portal/questions/q1"), "questions");
  assert.equal(activeNavItemId(NAV_GROUPS, "/portal/measurement"), "questions");
});

test("the real registry: the deepest matching item wins", () => {
  assert.equal(activeNavItemId(NAV_GROUPS, "/portal/settings"), "workspace-settings");
  assert.equal(activeNavItemId(NAV_GROUPS, "/portal/team"), "team");
});

test("the real registry: a path in no section has no active item", () => {
  assert.equal(activeNavItemId(NAV_GROUPS, "/portal/unknown/x"), null);
});

// --- switching -------------------------------------------------------------

test("a workspace switch keeps the deepest section of the current path", () => {
  assert.equal(sectionPathForSwitch(NAV_GROUPS, "/portal/scans/abc"), "/portal/scans");
  assert.equal(sectionPathForSwitch(NAV_GROUPS, "/portal/settings"), "/portal/settings");
  assert.equal(sectionPathForSwitch(NAV_GROUPS, "/portal/measurement"), "/portal/measurement");
});

test("a workspace switch from a path in no section lands on Overview", () => {
  assert.equal(sectionPathForSwitch(NAV_GROUPS, "/portal/unknown/x"), "/portal");
});

test("a workspace switch from Overview lands on Overview", () => {
  assert.equal(sectionPathForSwitch(NAV_GROUPS, "/portal"), "/portal");
});

// --- one active row ----------------------------------------------------------

test("overlapping items: only the deepest is active", () => {
  const groups: NavGroup[] = [
    {
      id: "g",
      label: "G",
      items: [
        item({ id: "scans", href: "/portal/scans" }),
        item({ id: "compare", href: "/portal/scans/compare" }),
      ],
    },
  ];
  assert.equal(activeNavItemId(groups, "/portal/scans/compare"), "compare");
  assert.equal(activeNavItemId(groups, "/portal/scans/compare/x"), "compare");
  assert.equal(activeNavItemId(groups, "/portal/scans/abc"), "scans");
});

test("a match through a deeper active prefix beats a shallower href", () => {
  const groups: NavGroup[] = [
    {
      id: "g",
      label: "G",
      items: [
        item({ id: "parent", href: "/portal/y" }),
        item({ id: "aliased", href: "/portal/x", activePrefixes: ["/portal/y/deep"] }),
      ],
    },
  ];
  assert.equal(activeNavItemId(groups, "/portal/y/deep/1"), "aliased");
  assert.equal(activeNavItemId(groups, "/portal/y/other"), "parent");
});

test("a workspace switch from a question lands on the questions list", () => {
  assert.equal(sectionPathForSwitch(NAV_GROUPS, "/portal/questions/q1"), "/portal/measurement");
});
