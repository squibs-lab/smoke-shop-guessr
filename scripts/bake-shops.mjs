#!/usr/bin/env node
// Builds shops.json for Smoke Shop Guessr.
//
// 1. Pulls every NYC smoke / vape / tobacco / head shop from OpenStreetMap (one Overpass query).
// 2. If STREETVIEW_KEY is set, asks Google's Street View *metadata* endpoint for the nearest
//    official panorama to each shop. Metadata requests are free and unlimited; they never
//    load imagery. Shops with no Street View nearby are dropped, and each kept shop gets its
//    panorama id, the camera heading that faces the storefront, and the photo date.
//    Everything matched is saved to shops-all.json (what review.html goes through).
// 3. Applies reviews.json (written by review.html) to make shops.json, what the game plays:
//    removed shops are left out, and kept shops are locked to the photo and angle that were reviewed.
//
// Run locally:  STREETVIEW_KEY=AIza... node scripts/bake-shops.mjs
//   Only re-apply reviews.json to the existing shops-all.json (no network, a second):
//               node scripts/bake-shops.mjs --apply-reviews
// Runs weekly in GitHub Actions (.github/workflows/bake-shops.yml), and with --apply-reviews
// whenever reviews.json changes.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const KEY = (process.env.STREETVIEW_KEY || "").trim();
const OUT = process.env.OUT || new URL("../shops.json", import.meta.url);
const ALL_OUT = process.env.ALL_OUT || new URL("../shops-all.json", import.meta.url);
const REVIEWS = process.env.REVIEWS || new URL("../reviews.json", import.meta.url);
const CUSTOM = process.env.CUSTOM || new URL("../custom-shops.json", import.meta.url);
const ATTRIBUTION = "Shop data © OpenStreetMap contributors (ODbL). Panorama ids from Google Street View.";
const RADIUS_M = 50;
const CONCURRENCY = 6;
const USER_AGENT = "smoke-shop-guessr/1.0 (weekly shop list build)";

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];
const SHOP_FILTER = `
  nwr["shop"~"^(tobacco|e-cigarette|cannabis|headshop|smoke_shop|vape|vape_shop|hookah)$"](area.nyc);
  nwr["shop"]["name"~"smoke|vape|hookah|head ?shop|tobacco|cigar",i](area.nyc);`;
const QUERY = `[out:json][timeout:180];area(id:3600175905)->.nyc;(${SHOP_FILTER});out center tags;`;
const NOT_SMOKE_SHOPS = /smoked|smokehouse|bbq|barbe?cue|fish|meat|salmon/i;

export function boroughFrom(zip, city) {
  const z = parseInt(String(zip || "").slice(0, 3), 10);
  if (z >= 100 && z <= 102) return "Manhattan";
  if (z === 103) return "Staten Island";
  if (z === 104) return "The Bronx";
  if (z === 112) return "Brooklyn";
  if ([110, 111, 113, 114, 116].includes(z)) return "Queens";
  const c = String(city || "").toLowerCase();
  if (c.includes("brooklyn")) return "Brooklyn";
  if (c.includes("bronx")) return "The Bronx";
  if (c.includes("staten")) return "Staten Island";
  if (c.includes("queens")) return "Queens";
  if (c.includes("manhattan")) return "Manhattan";
  return "";
}

export function km(a, b) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function bearing(a, b) {
  const r = Math.PI / 180;
  const p1 = a.lat * r, p2 = b.lat * r, dl = (b.lng - a.lng) * r;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / r + 360) % 360;
}

export function parseOverpass(els) {
  const seen = new Set(), out = [];
  for (const el of els) {
    const t = el.tags || {};
    const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null) continue;
    if (t.name && NOT_SMOKE_SHOPS.test(t.name)) continue;
    const name = t.name || t.brand || "Smoke shop with no name";
    const key = name.toLowerCase() + "|" + lat.toFixed(4) + "|" + lng.toFixed(4);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: el.type[0] + el.id,
      name,
      kind: t.shop || "",
      addr: [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" "),
      borough: boroughFrom(t["addr:postcode"], t["addr:city"]),
      lat: +lat.toFixed(6),
      lng: +lng.toFixed(6)
    });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

async function fetchOverpass() {
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "User-Agent": USER_AGENT },
        body: "data=" + encodeURIComponent(QUERY),
        signal: AbortSignal.timeout(240_000)
      });
      if (!r.ok) throw new Error(`${url} answered HTTP ${r.status}`);
      const j = await r.json();
      return j.elements || [];
    } catch (e) {
      lastErr = e;
      console.warn(`Overpass server failed, trying the next one: ${e.message}`);
    }
  }
  throw lastErr || new Error("Every Overpass server failed");
}

// Free: Street View metadata never loads imagery and has no usage cap.
async function streetViewMetadata(shop) {
  const params = new URLSearchParams({ location: `${shop.lat},${shop.lng}`, radius: String(RADIUS_M), source: "outdoor", key: KEY });
  const r = await fetch("https://maps.googleapis.com/maps/api/streetview/metadata?" + params, { signal: AbortSignal.timeout(20_000) });
  const j = await r.json();
  if (j.status === "REQUEST_DENIED" || j.status === "OVER_QUERY_LIMIT" || j.status === "INVALID_REQUEST") {
    const err = new Error(`Street View metadata said ${j.status}${j.error_message ? ": " + j.error_message : ""}`);
    err.fatal = true;
    throw err;
  }
  if (j.status !== "OK" || !j.pano_id || !j.location) return null;
  if (j.copyright && !/google/i.test(j.copyright)) return null; // skip user-uploaded photospheres
  return j;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

export async function matchPanoramas(shops, lookup = streetViewMetadata) {
  let done = 0;
  const results = await pool(shops, CONCURRENCY, async shop => {
    let meta = null;
    for (let attempt = 0; attempt < 3 && meta === null; attempt++) {
      try { meta = await lookup(shop); break; }
      catch (e) {
        if (e.fatal) throw e;
        if (attempt === 2) { console.warn(`Gave up on ${shop.name}: ${e.message}`); break; }
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    if (++done % 100 === 0) console.log(`  checked ${done}/${shops.length}`);
    if (!meta) return null;
    const panoPos = { lat: meta.location.lat, lng: meta.location.lng };
    if (km(panoPos, shop) > RADIUS_M / 1000 + 0.015) return null;
    return { ...shop, pano: meta.pano_id, heading: +bearing(panoPos, shop).toFixed(1), date: meta.date || "" };
  });
  return results.filter(Boolean);
}

// reviews: { [shopId]: { status: "keep" | "reject", pano?, heading?, date?, changed?, reason? } }
// Once any reviews exist, shops without a decision (new on OpenStreetMap) stay out of the game
// until they're kept on the review page. With no reviews at all, every matched shop plays.
export function applyReviews(shops, reviews = {}, { onlyReviewed = Object.keys(reviews).length > 0 } = {}) {
  const out = [];
  let removed = 0, kept = 0, reangled = 0, waiting = 0;
  for (const s of shops) {
    const r = reviews[s.id];
    // hand-picked shops (custom-shops.json) count as kept unless removed on the review page
    if (!r && onlyReviewed && !s.custom) { waiting++; continue; }
    if (r && r.status === "reject") { removed++; continue; }
    if (r && r.status === "keep") {
      kept++;
      const t = { ...s, reviewed: true };
      if (r.pano) {
        // a different photo than the one matched (another year, or a spot walked to): use its date if known
        if (r.date) t.date = r.date;
        else if (r.pano !== s.pano) t.date = "";
        t.pano = r.pano;
        if (typeof r.heading === "number") t.heading = Math.round(r.heading * 10) / 10;
        if (r.changed) reangled++;
      }
      out.push(t);
      continue;
    }
    out.push(s);
  }
  return { shops: out, removed, kept, reangled, waiting };
}

async function readJSON(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
const shown = p => (p instanceof URL ? fileURLToPath(p) : p);

// custom-shops.json: shops picked by hand that OpenStreetMap doesn't have.
export async function readCustomShops() {
  const j = await readJSON(CUSTOM);
  return ((j && j.shops) || [])
    .filter(s => s && s.id && s.name && Number.isFinite(s.lat) && Number.isFinite(s.lng))
    .map(s => ({
      id: String(s.id).startsWith("c-") ? String(s.id) : "c-" + s.id,
      name: s.name, kind: s.kind || "smoke_shop", addr: s.addr || "", borough: s.borough || "",
      lat: s.lat, lng: s.lng, custom: true,
      ...(s.pano ? { pano: s.pano, heading: Number(s.heading) || 0, date: s.date || "" } : {}),
      ...(s.needsPhotoAfter ? { needsPhotoAfter: s.needsPhotoAfter } : {})
    }));
}
// Framed customs (pano set) are used as written. Unframed ones need a Street View lookup, which only
// the full build does; one with needsPhotoAfter waits until the photo found is newer than that month.
function mergeCustom(list, custom) {
  const byId = new Map(list.filter(s => !s.custom).map(s => [s.id, s]));
  for (const c of custom) if (c.pano) byId.set(c.id, c);
  // keep customs the full build already matched, unless they've been taken out of custom-shops.json
  const ids = new Set(custom.map(c => c.id));
  for (const s of list) if (s.custom && ids.has(s.id) && !byId.has(s.id)) byId.set(s.id, s);
  return [...byId.values()];
}

async function writeGameList(all, updated) {
  const reviewsFile = await readJSON(REVIEWS);
  const reviews = (reviewsFile && reviewsFile.reviews) || {};
  const r = applyReviews(all, reviews);
  const body = {
    updated,
    attribution: ATTRIBUTION,
    count: r.shops.length,
    reviewed: r.kept,
    waitingForReview: r.waiting,
    shops: r.shops
  };
  await writeFile(OUT, JSON.stringify(body) + "\n");
  const unreviewed = all.length - r.kept - r.removed;
  console.log(`Reviews: ${r.kept} kept (${r.reangled} with a new view), ${r.removed} removed, ${unreviewed} not reviewed yet` +
    (r.waiting ? ` (left out of the game until reviewed).` : `.`));
  console.log(`Wrote ${r.shops.length} shops to ${shown(OUT)}.`);
}

export async function main() {
  if (process.argv.includes("--apply-reviews")) {
    const all = await readJSON(ALL_OUT);
    if (!all || !Array.isArray(all.shops)) throw new Error(`${shown(ALL_OUT)} doesn't exist yet. Run the full build first.`);
    const custom = await readCustomShops();
    const merged = mergeCustom(all.shops, custom);
    const unframed = custom.filter(c => !c.pano && !merged.some(s => s.id === c.id));
    if (unframed.length) console.log(`Hand-picked shops waiting for the full build to find their Street View: ${unframed.map(c => c.name).join(", ")}.`);
    if (merged.length !== all.shops.length || custom.length) {
      await writeFile(ALL_OUT, JSON.stringify({ ...all, count: merged.length, shops: merged }) + "\n");
    }
    return writeGameList(merged, all.updated);
  }

  console.log("Asking OpenStreetMap for NYC smoke shops…");
  const shops = parseOverpass(await fetchOverpass());
  console.log(`Found ${shops.length} shops.`);
  if (shops.length < 50) throw new Error(`Only ${shops.length} shops came back, which looks wrong. Not overwriting shops.json.`);

  let final = shops;
  if (KEY) {
    console.log("Matching each shop to its nearest Street View panorama (free metadata lookups)…");
    final = await matchPanoramas(shops);
    console.log(`${final.length} of ${shops.length} shops have Street View right outside.`);
    if (final.length < 50) throw new Error(`Only ${final.length} shops matched a panorama, which looks wrong. Not overwriting shops.json.`);
  } else {
    console.warn("STREETVIEW_KEY isn't set, so shops are saved without panoramas. The game will still work, but the camera won't face each storefront and some rounds may have no imagery.");
  }

  const custom = await readCustomShops();
  if (custom.length) {
    const framed = custom.filter(c => c.pano);
    let matched = [];
    const toMatch = custom.filter(c => !c.pano);
    if (toMatch.length && KEY) {
      matched = await matchPanoramas(toMatch);
      matched = matched.filter(m => {
        if (m.needsPhotoAfter && !((m.date || "") > m.needsPhotoAfter)) {
          console.log(`${m.name}: newest Street View is ${m.date || "undated"}, still waiting for a photo after ${m.needsPhotoAfter}.`);
          return false;
        }
        return true;
      });
    }
    const missing = toMatch.filter(c => !matched.some(m => m.id === c.id) && !c.needsPhotoAfter);
    if (missing.length) console.warn(`No Street View within ${RADIUS_M} m for: ${missing.map(c => c.name).join(", ")}.`);
    final = [...final.filter(s => !s.custom), ...framed, ...matched];
    console.log(`Hand-picked shops: ${framed.length + matched.length} of ${custom.length} added.`);
  }

  const updated = new Date().toISOString();
  await writeFile(ALL_OUT, JSON.stringify({ updated, attribution: ATTRIBUTION, count: final.length, shops: final }) + "\n");
  console.log(`Wrote ${final.length} shops to ${shown(ALL_OUT)}.`);
  await writeGameList(final, updated);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
