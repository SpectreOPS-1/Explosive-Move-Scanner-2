# Deploying Explosive Move Scanner v3 (Cloudflare Pages + one Worker)

Two pieces: the **Worker** (`worker/scanner-api.js`) holds your Alpaca and Finnhub keys and computes relative volume; the **app** (Pages) is the page you look at. All free.

## 1. Get the keys (5 min)
- **Alpaca**: sign up at alpaca.markets (a paper account is fine) -> API keys -> copy the Key ID and Secret.
- **Finnhub**: finnhub.io -> free key (used for share count and news).
- Make up a long **access code** (a passphrase). It stops strangers from spending your data quota.

## 2. Create the Worker
1. Cloudflare dashboard -> Workers & Pages -> Create -> Worker -> name it `scanner-api` -> Deploy.
2. Edit code -> paste all of `worker/scanner-api.js` -> Deploy.
3. Settings -> Variables and Secrets -> add as **Secrets**: `ALPACA_KEY_ID`, `ALPACA_SECRET`, `FINNHUB_KEY`, `ACCESS_CODE`.
4. Add a **Text** variable `ALLOWED_ORIGIN` = your Pages address (e.g. `https://explosive-scanner.pages.dev`). Do this after step 3 below if you do not have it yet.
5. Optional: Storage -> KV -> create namespace, bind it to the Worker as `CACHE`. Makes the first scan of a watchlist much faster.
6. Open `https://scanner-api.<you>.workers.dev/api/health`. You should see `{"ok":true,"alpaca":true,"finnhub":true,"accessCode":true,...}`. Any `false` means that secret is missing.

## 3. Deploy the app
Same as v2: push this folder to GitHub, create a Pages project (build `npm run build`, output `dist`), or run `npm run build` and upload `dist`.

## 4. Use it
Open the app, paste the Worker URL and your access code. Click **Fetch top 20**, then **Scan these now**.

## What to expect (read this)
- **Delay**: free Alpaca gives full-market (SIP) data only when it is older than 15 minutes, so scan prices are about 16 minutes behind. The movers list is real time.
- **RVOL**: volume since 4:00 AM ET divided by the 20-session average of the same clock window. Volume is full-market, so there is no IEX-only distortion. A name with fewer than 10 prior sessions shows RVOL as a dash instead of a guess.
- **Cold vs warm**: the first scan of a symbol downloads about 30 days of 5-minute bars (a few seconds per 5 tickers). Repeats the same day are quick.
- **Limits**: Alpaca free is 200 calls/min. A 40-ticker cold scan uses roughly 25 to 30. The Worker allows 5 tickers per request (Cloudflare free caps outbound calls per request).
- **Movers**: warrants, rights, units and names under your minimum price are dropped by default (it is a ticker-shape guess, so an odd name can slip through). Shares outstanding stands in for float.
- **Not verified**: I built and tested this against simulated Alpaca/Finnhub replies only. The sandbox cannot reach the real services, so check these on first run: the movers endpoint (some free accounts may not have screener access; the app will show Alpaca's message) and the `/api/health` flags.

Run the tests any time with `npm test`.
