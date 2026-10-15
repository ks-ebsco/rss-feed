// Fetches the UN Health News RSS feed and writes site/index.html.
// Run by the GitHub Action on a schedule. If the feed fails, this script exits
// with an error, nothing is published, and the last good copy stays online.

import { mkdir, readFile, writeFile } from "node:fs/promises";

const FEED_URL = "https://news.un.org/feed/subscribe/en/news/topic/health/feed/rss.xml";
const MORE_URL = "https://news.un.org/en/news/topic/health";
const MORE_LABEL = "Read More from UN Health News";
const ITEM_COUNT = 5;

async function getFeedXml() {
  // FEED_FILE lets you test locally with a saved copy of the feed.
  if (process.env.FEED_FILE) return readFile(process.env.FEED_FILE, "utf8");
  const res = await fetch(FEED_URL, {
    headers: { "User-Agent": "NewsWidget/1.0 (RSS embed)" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Feed returned ${res.status}`);
  return res.text();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`));
  if (!m) return "";
  return m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
}

function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function parseFeed(xml) {
  const items = [];
  for (const block of xml.match(/<item\b[\s\S]*?<\/item>/g) || []) {
    const title = decode(tag(block, "title"));
    const guid = tag(block, "guid");
    const link = /^https?:/.test(guid) ? guid : tag(block, "link");
    const pubDate = tag(block, "pubDate");
    if (title && link) items.push({ title, link, date: pubDate ? new Date(pubDate) : null });
  }
  return items.sort((a, b) => (b.date || 0) - (a.date || 0));
}

function formatDate(d) {
  if (!d || isNaN(d)) return "";
  // e.g. "Oct 12, 2026 12:00 PM" (UTC, matching the original widget)
  return d
    .toLocaleString("en-US", {
      month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit", timeZone: "UTC",
    })
    .replace(/(\d{4}),/, "$1")
    .replace(" at ", " ");
}

const STYLE = `
  :root { --link:#136a8a; --text:#333; --border:#d6d6d6; --footer:#f7f7f7; }
  * { box-sizing: border-box; }
  html, body { margin:0; overflow:hidden; } /* no scrollbars inside the iframe */
  body { font-family: Inter, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color:var(--text); background:transparent; }
  .box { border:1px solid var(--border); border-radius:3px; overflow:hidden; background:#fff; }
  ul { list-style:none; margin:0; padding:0; }
  li { padding:10px 10px 9px; border-bottom:1px solid var(--border); }
  /* Titles stay on one line and end with an ellipsis when too long */
  .title { display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  a { color:var(--link); text-decoration:none; font-size:16px; line-height:22px; }
  a:hover, a:focus-visible { text-decoration:underline; }
  a:focus-visible { outline:2px solid var(--link); outline-offset:2px; }
  .date { margin-top:5px; font-size:13px; line-height:16px; white-space:nowrap; }
  .more { background:var(--footer); padding:10px; text-align:right; white-space:nowrap; }
  .more a { font-size:13px; line-height:16px; }
`;

function render(items) {
  const lis = items
    .map(
      (i) =>
        `<li><a class="title" href="${esc(i.link)}" rel="noopener" title="${esc(i.title)}">${esc(i.title)}</a>` +
        `<div class="date">${esc(formatDate(i.date))}</div></li>`
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<title>Current News</title><style>${STYLE}</style></head>
<body><div class="box"><ul>${lis}</ul><div class="more"><a href="${esc(MORE_URL)}" rel="noopener">${esc(MORE_LABEL)}</a></div></div></body></html>
`;
}

const items = parseFeed(await getFeedXml());
if (!items.length) throw new Error("Feed had no items; not publishing.");

await mkdir("site", { recursive: true });
await writeFile("site/index.html", render(items.slice(0, ITEM_COUNT)));
console.log(`Wrote site/index.html with ${Math.min(items.length, ITEM_COUNT)} items.`);
