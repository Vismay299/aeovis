// Pure, client-safe Google Maps coordinate parser and link builder.
// No Node or server dependencies, no network calls.

export type ParsedMapsLocation = {
  latitude: number;
  longitude: number;
  zoom: number | null;
};

function isValidLatLng(lat: number, lng: number): boolean {
  return (
    !Number.isNaN(lat) &&
    !Number.isNaN(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * Parses coordinates and optional zoom from a Google Maps link or coordinates string.
 *
 * Supported formats:
 * - URL with `@<lat>,<lng>,<z>z` (zoom clamped 4-18, rounded)
 * - Place URL with `!3d<lat>!4d<lng>` (zoom null)
 * - Plain `"lat, lng"` or `"lat lng"` (zoom null)
 *
 * Rejects latitude outside ±90, longitude outside ±180, short links (e.g. maps.app.goo.gl),
 * and unrecognized text with null. Makes no network call.
 */
export function parseMapsLocation(input: string): ParsedMapsLocation | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Short links cannot be expanded without network calls; reject them.
  if (trimmed.includes("maps.app.goo.gl") || trimmed.includes("goo.gl/maps")) {
    return null;
  }

  // 1. Matches URLs containing @lat,lng,<zoom>z or @lat,lng
  const atMatch = trimmed.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?)z)?/);
  if (atMatch) {
    const lat = Number(atMatch[1]);
    const lng = Number(atMatch[2]);
    let zoom: number | null = null;
    if (atMatch[3] !== undefined) {
      const parsedZoom = Math.round(Number(atMatch[3]));
      zoom = Math.min(18, Math.max(4, parsedZoom));
    }
    if (isValidLatLng(lat, lng)) {
      return { latitude: lat, longitude: lng, zoom };
    }
    return null;
  }

  // 2. Matches place URLs with !3d<lat>!4d<lng>
  const placeMatch = trimmed.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (placeMatch) {
    const lat = Number(placeMatch[1]);
    const lng = Number(placeMatch[2]);
    if (isValidLatLng(lat, lng)) {
      return { latitude: lat, longitude: lng, zoom: null };
    }
    return null;
  }

  // 3. Plain "lat, lng" or "lat lng"
  const plainMatch = trimmed.match(/^(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)$/);
  if (plainMatch) {
    const lat = Number(plainMatch[1]);
    const lng = Number(plainMatch[2]);
    if (isValidLatLng(lat, lng)) {
      return { latitude: lat, longitude: lng, zoom: null };
    }
    return null;
  }

  return null;
}

/**
 * Builds a Google Maps search URL or coordinates URL.
 * e.g. `https://www.google.com/maps/search/<encoded keyword>/@lat,lng,<z>z`
 * or `https://www.google.com/maps/@lat,lng,<z>z` when no keyword is provided.
 */
export function googleMapsPointUrl(
  latitude: number,
  longitude: number,
  zoom: number,
  keyword?: string,
): string {
  const z = Math.min(18, Math.max(4, Math.round(zoom)));
  const coords = `@${latitude},${longitude},${z}z`;
  if (keyword && keyword.trim()) {
    return `https://www.google.com/maps/search/${encodeURIComponent(keyword.trim())}/${coords}`;
  }
  return `https://www.google.com/maps/${coords}`;
}
