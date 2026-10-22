# Smoke Shop Guessr

GeoGuessr, but every round is a New York City smoke shop. Unlimited random games of five rounds, plus an optional daily game that everyone gets the same shops for, and a copyable score.

## What it costs to run: $0

| Piece | What it uses | Cost |
|---|---|---|
| Street View, first ~160 visits a day | Google Maps JavaScript API (paid Street View) | Free: inside Google's 5,000 free loads a month, held there by a daily cap |
| Street View, everyone after that | Google Maps Embed API | Free, no usage cap |
| Guess map and results map | MapLibre + OpenFreeMap tiles | Free, no key |
| Shop list | OpenStreetMap, baked once a week by a GitHub job | Free |
| Matching shops to Street View | Google Street View metadata lookups, weekly | Free, no usage cap |
| Hosting | GitHub Pages (or Cloudflare Pages) | Free |

Google still makes you turn on billing for the project, but nothing above is ever charged as long as the daily cap in setup step 1.5 is in place.

### How Street View switches between paid and free

The game uses two kinds of Google Street View:

- **Paid (Maps JavaScript API):** street names on the road and the address box are switched off with Google's own settings. Google bills each Street View viewer created, and the game creates one per visit, reusing it for every round. Google gives 5,000 a month free.
- **Free (Maps Embed API):** free and unlimited, but it shows an address card in the top-left corner, and street names can show on the road while walking around. The game pushes the top 120px of the embed off-screen so the card never shows (`--crop` at the top of the CSS). If you ever see an address peeking out, raise `--crop`. Hiding the card is a gray area in Google's terms.

Each game starts on paid Street View and switches to free when any of these happen:

- Google refuses for any reason. The daily cap being reached is the main one; a key or billing problem counts too. That browser then stays on free until midnight Pacific time, when Google's daily limits reset.
- The browser has already played 2 paid games today (`PAID_GAMES_PER_BROWSER`), so one person can't use up the day's allowance.
- A Street View photo is slow or broken. That round goes free, and two in a row finish the game on free.

To turn paid off entirely, set `STREET_VIEW = "free"` at the top of the script.

## Setup

### 1. Google Cloud (one time)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and turn on billing.
2. Enable three APIs: **Maps Embed API**, **Maps JavaScript API** and **Street View Static API**.
3. Create **key 1, the browser key**:
   - API restrictions: **Maps Embed API** and **Maps JavaScript API** only.
   - Website restrictions: your site, for example `squibs-lab.github.io/*`.
   - Paste it into `GOOGLE_KEY` at the top of the script in `index.html`.
4. Create **key 2, the shop-list key**:
   - API restrictions: **Street View Static API** only.
   - No website restriction (it runs on GitHub's servers).
   - Never put it in `index.html`. It goes into GitHub as a secret (step 2).
5. **The daily cap that keeps paid Street View at $0.** Google Maps Platform → Quotas → Maps JavaScript API → **Map loads per day** → Edit → set it to **160**. Google's free 5,000 a month works out to 161 a day in a 31-day month. Do this before allowing the Maps JavaScript API on key 1. After the first paid game, check this quota's current usage went up, which confirms Street View counts toward it.
6. Optional safety net: in the Street View Static API's quotas, cap requests per day at about 5,000. The weekly job uses roughly one request per shop, and the cap means a leaked key 2 couldn't be used to pull paid images at scale.

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
- Key 1's website restriction blocks Street View when the page is a local file. Test on the live site.

## Files

- `index.html`: the whole game.
- `shops.json`: the shop list, rebuilt weekly. Don't edit it by hand.
- `scripts/bake-shops.mjs`: builds `shops.json`. Run it yourself with `STREETVIEW_KEY=... node scripts/bake-shops.mjs`.
- `.github/workflows/bake-shops.yml`: the weekly job.

Shop data © OpenStreetMap contributors (ODbL). Street View © Google. Map tiles by OpenFreeMap.
