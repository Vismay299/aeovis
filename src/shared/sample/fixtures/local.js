/** Local SEO: Brightwave's Pune office listing, reviews, a 5x5 map-rank grid and local results. */
import { BRAND, daysAgo, stable } from "./brand.js";

const CENTER = { latitude: 18.5204, longitude: 73.8567 };
const OWN = {
  id: "c1000000-0000-4000-8000-000000000001", role: "own", title: `${BRAND} Health — Pune`, cid: "4815162342000000001", placeId: "ChIJ-sample-brightwave-pune",
  latitude: CENTER.latitude, longitude: CENTER.longitude,
  profile: {
    title: `${BRAND} Health — Pune`, category: "Software company", additionalCategories: ["Medical software company"],
    rating: { value: 4.7, votes: 86 }, ratingDistribution: { 5: 64, 4: 17, 3: 3, 2: 1, 1: 1 },
    address: "Baner Road, Pune, Maharashtra 411045", phone: "+91 20 0000 0000", website: "https://brightwave.io", domain: "brightwave.io",
    hours: [{ day: "monday", spans: [{ open: "09:30", close: "18:30" }] }, { day: "tuesday", spans: [{ open: "09:30", close: "18:30" }] }, { day: "wednesday", spans: [{ open: "09:30", close: "18:30" }] }, { day: "thursday", spans: [{ open: "09:30", close: "18:30" }] }, { day: "friday", spans: [{ open: "09:30", close: "18:30" }] }],
    currentStatus: "open", isClaimed: true, totalPhotos: 24, cid: "4815162342000000001", placeId: "ChIJ-sample-brightwave-pune",
    latitude: 18.5204, longitude: 73.8567,
  },
  profileFetchedAt: daysAgo(5),
};
const RIVAL_LISTINGS = [
  { id: "c1000000-0000-4000-8000-000000000002", role: "competitor", title: "NorthPeak Systems", cid: "4815162342000000002", placeId: "ChIJ-sample-northpeak", latitude: 18.5310, longitude: 73.8446, profile: null, profileFetchedAt: null },
  { id: "c1000000-0000-4000-8000-000000000003", role: "competitor", title: "Lumen IQ Analytics", cid: "4815162342000000003", placeId: "ChIJ-sample-lumeniq", latitude: 18.5089, longitude: 73.8259, profile: null, profileFetchedAt: null },
];

export const businesses = () => ({ businesses: [OWN, ...RIVAL_LISTINGS] });
export const business = (id) => [OWN, ...RIVAL_LISTINGS].find((b) => b.id === id);
export const profile = () => ({ profile: OWN.profile, businessId: OWN.id });

const REVIEWS = [
  [5, "Their readmission dashboard replaced three spreadsheets for our quality team."],
  [5, "Onboarding with our HIMS took two weeks. NABH reports now take an hour, not a week."],
  [4, "Good analytics. Would like more customisable exports."],
  [5, "Support team understands hospital workflows, not just software."],
  [4, "Length-of-stay views are excellent; mobile app is basic."],
];
export function fetches() {
  return { fetches: [{ id: "c2000000-0000-4000-8000-000000000001", kind: "reviews", status: "completed", itemCount: REVIEWS.length, createdAt: daysAgo(5), params: { depth: 20 } }] };
}
export function fetchDetail(id) {
  if (id !== "c2000000-0000-4000-8000-000000000001") return undefined;
  return {
    id, kind: "reviews", status: "completed", businessId: OWN.id, params: { depth: 20, sortBy: "newest", includeOtherSources: false },
    totals: { reviewsCount: 86, rating: 4.7, title: OWN.title },
    items: REVIEWS.map(([value, review_text], i) => ({ rank_absolute: i + 1, rating: { value }, review_text, timestamp: daysAgo(6 + i * 9), profile_name: ["Dr. S. Kulkarni", "Quality Head, Pune", "IT Manager", "Dr. A. Rao", "Admin, Nashik"][i] })),
    itemCount: REVIEWS.length, reused: false, error: null, createdAt: daysAgo(5), completedAt: daysAgo(5), pollAfterSeconds: null,
  };
}

const GRID_ID = "c3000000-0000-4000-8000-000000000001";
const SIZE = 5;
function gridPoints() {
  const step = 0.018;
  return Array.from({ length: SIZE * SIZE }, (_, i) => {
    const row = Math.floor(i / SIZE);
    const col = i % SIZE;
    const dist = Math.abs(row - 2) + Math.abs(col - 2);
    const rank = dist === 0 ? 1 : Math.min(20, dist * 2 + Math.round(stable(`g${i}`) * 3));
    return { row, col, latitude: CENTER.latitude + (2 - row) * step, longitude: CENTER.longitude + (col - 2) * step, rank: dist > 3 ? null : rank, resultsCount: 20, topResult: { title: rank === 1 ? OWN.title : "NorthPeak Systems", cid: rank === 1 ? OWN.cid : RIVAL_LISTINGS[0].cid } };
  });
}
function summary(points) {
  const found = points.filter((p) => p.rank);
  return { pointsSearched: points.length, pointsFound: found.length, failed: 0, averageRank: Math.round((found.reduce((s, p) => s + p.rank, 0) / found.length) * 100) / 100, top3Count: found.filter((p) => p.rank <= 3).length, top10Count: found.filter((p) => p.rank <= 10).length };
}
export function grids() {
  const pts = gridPoints();
  return { grids: [{ id: GRID_ID, keyword: "hospital software company", gridSize: SIZE, spacingKm: 2, status: "completed", summary: summary(pts), createdAt: daysAgo(6) }] };
}
export function grid(id) {
  if (id !== GRID_ID) return undefined;
  const points = gridPoints();
  return { id, status: "completed", keyword: "hospital software company", center: CENTER, gridSize: SIZE, spacingKm: 2, zoom: 13, device: "mobile", pointsReady: points.length, pointsTotal: points.length, points, summary: summary(points), matched: { title: OWN.title, cid: OWN.cid, placeId: OWN.placeId }, reused: false, error: null, createdAt: daysAgo(6), pollAfterSeconds: null };
}

export function serp() {
  const names = ["NorthPeak Systems", "Lumen IQ Analytics", OWN.title, "Vantage Health Tech", "Coreset Software"];
  return { results: names.map((title, i) => ({ rank: i + 1, title, rating: [4.4, 4.2, 4.7, 4.0, 3.9][i], votes: [212, 140, 86, 64, 38][i], isOwn: title === OWN.title })), ownRank: 3, cached: true, fetchedAt: daysAgo(2) };
}
export function listings() {
  return { businesses: [["NorthPeak Systems", 4.4, 212], ["Lumen IQ Analytics", 4.2, 140], [OWN.title, 4.7, 86], ["Vantage Health Tech", 4.0, 64]].map(([title, rating, votes]) => ({ title, category: "Software company", rating, votes, isClaimed: true, isSaved: null })), cached: true, fetchedAt: daysAgo(2) };
}
export const categories = () => ({ categories: ["Software company", "Medical software company", "Business management consultant"] });
