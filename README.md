# Explosive Move Scanner

Momentum (PMO 13/8/5), time-of-day relative volume and share count, scored 0 to 100. Includes a Top 20 movers loader.

- Flat layout: all app files sit at the top level (the Worker code is `scanner-api.js`).
- `worker/scanner-api.js` Cloudflare Worker that holds the Alpaca/Finnhub keys and computes RVOL
- `tests/` run with `npm test`

Setup and deployment: see [DEPLOY.md](DEPLOY.md). Never commit API keys; they live only as Worker secrets.

Screening aid only, not investment advice.
