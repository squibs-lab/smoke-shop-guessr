#!/usr/bin/env node
// Builds shops.json for Smoke Shop Guessr.
//
// 1. Pulls every NYC smoke / vape / tobacco / head shop from OpenStreetMap (one Overpass query).
// 2. If STREETVIEW_KEY is set, asks Google's Street View *metadata* endpoint for the nearest
//    official panorama to each shop. Metadata requests are free and unlimited; they never
//    load imagery. Shops with no Street View nearby are dropped, and each kept shop gets its
//    panorama id, the camera heading that faces the storefront, and the photo date.
//
// Run locally:  STREETVIEW_KEY=AIza... node scripts/bake-shops.mjs
// Runs weekly in GitHub Actions (.github/workflows/bake-shops.yml).

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const KEY = (process.env.STREETVIEW_KEY || "").trim();
const OUT = process.env.OUT || new URL("../shops.json", import.meta.url);
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

export async function main() {
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

  const body = {
    updated: new Date().toISOString(),
    attribution: "Shop data © OpenStreetMap contributors (ODbL). Panorama ids from Google Street View.",
    count: final.length,
    shops: final
  };
  await writeFile(OUT, JSON.stringify(body) + "\n");
  console.log(`Wrote ${final.length} shops to ${OUT instanceof URL ? fileURLToPath(OUT) : OUT}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
