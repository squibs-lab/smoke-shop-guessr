# Smoke Shop Guessr

GeoGuessr, but every round is a New York City smoke shop. Unlimited random games of five rounds, plus an optional daily game that everyone gets the same shops for, and a copyable score.

## What it costs to run: $0

| Piece | What it uses | Cost |
|---|---|---|
| Street View in each round | Google Maps Embed API | Free, no usage cap |
| Guess map and results map | MapLibre + OpenFreeMap tiles | Free, no key |
| Shop list | OpenStreetMap, baked once a week by a GitHub job | Free |
| Matching shops to Street View | Google Street View metadata lookups, weekly | Free, no usage cap |
| Hosting | GitHub Pages (or Cloudflare Pages) | Free |

Google still makes you turn on billing for the project, but nothing above is ever charged. The browser key is limited to the Embed API, so even a stolen copy of it can't run up a bill.

### The one trade-off

The free Street View embed shows an address card in its top-left corner. The game pushes the top 120px of the embed off-screen so the card never shows (`--crop` at the top of the CSS). Two things to know:

- If you ever see an address peeking out, raise `--crop`.
- In "Walk around" mode, the street names Google draws on the road can show. "No looking around" mode blocks all interaction, so it has no hints.

Hiding the card is a gray area in Google's terms. If Google ever objects, set `IMAGERY = "dynamic"` at the top of the script. That switches to the paid Maps JavaScript API Street View, which hides addresses and street names natively. It costs money per game, so the game also limits random games per browser per day in that mode.

## Setup

### 1. Google Cloud (one time)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and turn on billing.
2. Enable two APIs: **Maps Embed API** and **Street View Static API**.
3. Create **key 1, the browser key**:
   - API restrictions: **Maps Embed API** only.
   - Website restrictions: your site, for example `squibs-lab.github.io/*`.
   - Paste it into `GOOGLE_KEY` at the top of the script in `index.html`.
4. Create **key 2, the shop-list key**:
   - API restrictions: **Street View Static API** only.
   - No website restriction (it runs on GitHub's servers).
   - Never put it in `index.html`. It goes into GitHub as a secret (step 2).
5. Optional safety net: in the Street View Static API's quotas, cap requests per day at about 5,000. The weekly job uses roughly one request per shop, and the cap means a leaked key 2 couldn't be used to pull paid images at scale.

### 2. GitHub (one time)

1. Create a public repo and push these files to it.
2. Settings → Secrets and variables → Actions → New repository secret. Name it `STREETVIEW_KEY` and paste key 2.
3. Settings → Pages → deploy from the `main` branch, root folder.
4. Actions → **Bake shop list** → Run workflow. This creates `shops.json`. It then reruns every Monday by itself.

### 3. Play

Open your Pages link. The start screen shows how many shops are on the map.

## Testing on your own computer

Opening `index.html` straight from your files works, with two limits:

- With no `shops.json` yet, the game pulls shops live from OpenStreetMap. The camera won't face the storefront, and a few rounds may have no imagery. Use **Skip this shop** in random games.
- Key 1's website restriction blocks the embed when the page is a local file. Test with a temporary unrestricted Embed-only key, or test on the live site.

## Files

- `index.html`: the whole game.
- `shops.json`: the shop list, rebuilt weekly. Don't edit it by hand.
- `scripts/bake-shops.mjs`: builds `shops.json`. Run it yourself with `STREETVIEW_KEY=... node scripts/bake-shops.mjs`.
- `.github/workflows/bake-shops.yml`: the weekly job.

Shop data © OpenStreetMap contributors (ODbL). Street View © Google. Map tiles by OpenFreeMap.
