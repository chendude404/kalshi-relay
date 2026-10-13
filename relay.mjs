// Fetch Kalshi public market prices and POST them to the bot's /kalshi-ingest route.
//
//   node relay.mjs                 loop every 15 s forever
//   node relay.mjs --minutes 340   loop, then exit after 340 minutes (GitHub Actions)
//   node relay.mjs --once          one push
//
// Needs BOT_URL in the environment. Never logs it.

import fs from "node:fs";

const BOT_URL = process.env.BOT_URL;
if (!BOT_URL) throw new Error("BOT_URL not set");
const KAL = "https://api.elections.kalshi.com/trade-api/v2";
const tickers = JSON.parse(fs.readFileSync(new URL("./tickers.json", import.meta.url), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (x) => (x == null || x === "" ? null : Number(x));

// {bid, ask, mid, bidSize, askSize, last, vol24h} as probabilities; handles the
// *_dollars string fields and the older integer-cent fields.
function kalshiPrice(m) {
  const dollars = (k) => (m[`${k}_dollars`] != null ? num(m[`${k}_dollars`]) : m[k] != null ? num(m[k]) / 100 : null);
  const bid = dollars("yes_bid");
  const ask = dollars("yes_ask");
  const ok = (x) => x != null && x > 0 && x < 1;
  return {
    bid: ok(bid) ? bid : null,
    ask: ok(ask) ? ask : null,
    mid: ok(bid) && ok(ask) ? (bid + ask) / 2 : null,
    bidSize: num(m.yes_bid_size_fp ?? m.yes_bid_size),
    askSize: num(m.yes_ask_size_fp ?? m.yes_ask_size),
    last: dollars("last_price"),
    vol24h: num(m.volume_24h_fp ?? m.volume_24h),
  };
}

async function pushOnce() {
  const prices = {};
  for (let i = 0; i < tickers.length; i += 100) {
    const r = await fetch(`${KAL}/markets?tickers=${encodeURIComponent(tickers.slice(i, i + 100).join(","))}&limit=100`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Kalshi ${r.status}${r.headers.get("Retry-After") ? ` retry-after ${r.headers.get("Retry-After")}` : ""}`);
    for (const m of (await r.json()).markets || []) {
      const p = kalshiPrice(m);
      if (p.mid != null) prices[m.ticker] = p;
    }
  }
  const res = await fetch(`${BOT_URL}/kalshi-ingest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ at: Date.now(), prices }), signal: AbortSignal.timeout(15000) });
  const j = await res.json().catch(() => ({}));
  console.log(`${new Date().toISOString()} pushed ${Object.keys(prices).length}/${tickers.length} -> ${res.status} ${JSON.stringify(j)}`);
}

const minutes = process.argv.includes("--minutes") ? Number(process.argv[process.argv.indexOf("--minutes") + 1]) : Infinity;
const stopAt = Date.now() + minutes * 60000;

if (process.argv.includes("--once")) await pushOnce();
else {
  while (Date.now() < stopAt) {
    try {
      await pushOnce();
    } catch (e) {
      console.log(`${new Date().toISOString()} push failed: ${e.cause?.code || e.message}`);
    }
    await sleep(15000);
  }
}
