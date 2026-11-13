export type LocalEventName =
  | "local:business_saved"
  | "local:profile_lookup"
  | "local:listings_search"
  | "local:reviews_collect"
  | "local:updates_collect"
  | "local:questions_collect"
  | "local:serp_search"
  | "local:grid_run";

/** Every event name, for tests and for the F26 adapter. */
export const LOCAL_EVENT_NAMES: readonly LocalEventName[] = [
  "local:business_saved",
  "local:profile_lookup",
  "local:listings_search",
  "local:reviews_collect",
  "local:updates_collect",
  "local:questions_collect",
  "local:serp_search",
  "local:grid_run",
];

/**
 * F17 §6.7: the only properties each event may carry. Nothing that names a
 * person, quotes review or post text, or gives a coordinate or keyword may
 * leave the browser, so the allow-list is enforced here rather than trusted
 * at each call site.
 */
export const LOCAL_EVENT_PROP_KEYS: Record<
  LocalEventName,
  readonly string[]
> = {
  "local:business_saved": ["role"],
  "local:profile_lookup": ["found"],
  "local:listings_search": ["count", "cached"],
  "local:reviews_collect": ["depth", "other_sources", "reused"],
  "local:updates_collect": ["reused"],
  "local:questions_collect": ["reused"],
  "local:serp_search": ["type", "cached", "own_ranked"],
  "local:grid_run": ["size", "reused", "points_found"],
};

export type LocalEventProps = Record<string, string | number | boolean | null>;

export type LocalEventTracker = (
  name: LocalEventName,
  props?: LocalEventProps
) => void;

let tracker: LocalEventTracker | null = null;

export function setLocalEventTracker(fn: LocalEventTracker | null): void {
  tracker = fn;
}

/**
 * Drops every property the event does not declare and any value that is not a
 * plain scalar, so a future call site cannot leak a name, review text,
 * coordinate or keyword into telemetry.
 */
export function sanitizeLocalEventProps(
  name: LocalEventName,
  props?: Record<string, unknown>
): LocalEventProps | undefined {
  if (!props) return undefined;
  const allowed = LOCAL_EVENT_PROP_KEYS[name];
  const clean: LocalEventProps = {};
  for (const key of allowed) {
    const value = props[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      clean[key] = value;
    }
  }
  return clean;
}

export function trackLocalEvent(
  name: LocalEventName,
  props?: Record<string, unknown>
): void {
  if (tracker) {
    try {
      tracker(name, sanitizeLocalEventProps(name, props));
    } catch {
      // Telemetry failures must never break user actions
    }
  }
}
