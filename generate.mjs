// Builds one news-block page per feed and writes them to the site/ folder.
// Run by the GitHub Action on a schedule.
//
//   site/un-health/index.html -> UN Health News
//   site/nursing/index.html   -> Journal of Advanced Nursing
//
// If a feed fails, that feed's last live copy is reused so its page keeps
// working, the other feeds still update, and the run is flagged as failed
// so you get a notification.

import { mkdir, readFile, writeFile } from "node:fs/promises";

// ---- Settings: add, remove or edit feeds here ------------------------------

const ITEM_COUNT = 5;

const FEEDS = [
  {
    slug: "un-health", // served at .../rss-feed/un-health/
    name: "UN Health News",
    url: "https://news.un.org/feed/subscribe/en/news/topic/health/feed/rss.xml",
    moreUrl: "https://news.un.org/en/news/topic/health",
    moreLabel: "Read More from UN Health News",
  },
  {
    slug: "nursing", // served at .../rss-feed/nursing/
    name: "Journal of Advanced Nursing",
    url: "https://onlinelibrary.wiley.com/action/showFeed?jc=13652648&type=etoc&feed=rss",
    moreUrl: "https://onlinelibrary.wiley.com/journal/13652648",
    moreLabel: "Read More from Journal of Advanced Nursing",
  },
];

// Set by the workflow, e.g. https://ks-ebsco.github.io/news-widget
const SITE_URL = (process.env.SITE_URL || "").replace(/\/$/, "");

// ---- Fetching ---------------------------------------------------------------

async function getFeedXml(feed) {
  // FEED_FILES lets you test locally: {"": "a.xml", "nursing": "b.xml"}
  if (process.env.FEED_FILES) {
    const local = JSON.parse(process.env.FEED_FILES);
    if (feed.slug in local) return readFile(local[feed.slug], "utf8");
  }
  const res = await fetch(feed.url, {
    headers: {
      "User-Agent": "NewsWidget/1.0 (RSS embed)",
      Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Feed returned ${res.status}`);
  return res.text();
}

// The page currently live on GitHub Pages, used if a fresh fetch fails.
async function getLiveCopy(feed) {
  if (!SITE_URL) return null;
  try {
    const res = await fetch(`${SITE_URL}/${feed.slug ? feed.slug + "/" : ""}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    return html.includes('class="box"') ? html : null;
  } catch {
    return null;
  }
}

// ---- Parsing (RSS 2.0, RSS 1.0 / RDF, and Atom) ------------------------------

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

// Titles can contain markup such as <i>...</i>; keep the words, drop the tags.
function cleanTitle(raw) {
  return decode(raw).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function itemLink(block) {
  const guid = decode(tag(block, "guid"));
  if (/^https?:/.test(guid)) return guid;
  const link = decode(tag(block, "link"));
  if (/^https?:/.test(link)) return link;
  const atom = block.match(/<link\b[^>]*\bhref="([^"]+)"/); // Atom
  if (atom) return decode(atom[1]);
  const about = block.match(/<item\b[^>]*\brdf:about="([^"]+)"/); // RSS 1.0
  return about ? decode(about[1]) : "";
}

const DATE_TAGS = ["pubDate", "dc:date", "published", "updated", "prism:publicationDate", "prism:coverDate"];

function itemDate(block) {
  for (const t of DATE_TAGS) {
    const raw = tag(block, t);
    if (!raw) continue;
    const d = new Date(raw);
    if (!isNaN(d)) return { date: d, hasTime: /[T ]\d{1,2}:\d{2}/.test(raw) };
  }
  return { date: null, hasTime: false };
}

function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/g) || [];
  for (const block of blocks) {
    const title = cleanTitle(tag(block, "title"));
    const link = itemLink(block);
    if (!title || !link) continue;
    items.push({ title, link, ...itemDate(block) });
  }
  return items.sort((a, b) => (b.date || 0) - (a.date || 0));
}

// ---- Rendering --------------------------------------------------------------

function formatDate({ date, hasTime }) {
  if (!date) return "\u00a0"; // keeps the row height consistent
  const opts = { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" };
  if (hasTime) Object.assign(opts, { hour: "numeric", minute: "2-digit" });
  // e.g. "Oct 12, 2026 12:00 PM" (UTC, matching the original widget)
  return date.toLocaleString("en-US", opts).replace(/(\d{4}),/, "$1").replace(" at ", " ");
}

const STYLE = `
  :root { --font-family-base: Inter, system-ui, sans-serif; --link:#136a8a; --text:#333; --border:#d6d6d6; --footer:#f7f7f7; }
  * { box-sizing: border-box; }
  html, body { margin:0; overflow:hidden; } /* no scrollbars inside the iframe */
  body { font-family: var(--font-family-base); color:var(--text); background:transparent; }
  .box { border:1px solid var(--border); border-radius:3px; overflow:hidden; background:#fff; }
  ul { list-style:none; margin:0; padding:0; }
  li { padding:10px 10px 9px; border-bottom:1px solid var(--border); }
  /* Titles stay on one line and end with an ellipsis when too long */
  .title { display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  a { color:var(--link); text-decoration:none; font-size:16px; line-height:22px; }
  a:hover, a:focus-visible { text-decoration:underline; }
  a:focus-visible { outline:2px solid var(--link); outline-offset:2px; }
  .date { margin-top:5px; font-size:14px; line-height:18px; white-space:nowrap; }
  .more { background:var(--footer); padding:10px; text-align:right; white-space:nowrap; }
  .more a { font-size:13px; line-height:16px; }
`;

function render(items, feed) {
  const lis = items
    .map(
      (i) =>
        `<li><a class="title" href="${esc(i.link)}" rel="noopener" title="${esc(i.title)}">${esc(i.title)}</a>` +
        `<div class="date">${esc(formatDate(i))}</div></li>`
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<title>${esc(feed.name)}</title><style>${STYLE}</style></head>
<body><div class="box"><ul>${lis}</ul><div class="more"><a href="${esc(feed.moreUrl)}" rel="noopener">${esc(feed.moreLabel)}</a></div></div></body></html>
`;
}

// ---- Main -------------------------------------------------------------------

const failures = [];
let pagesWritten = 0;

for (const feed of FEEDS) {
  let html = null;
  try {
    const items = parseFeed(await getFeedXml(feed));
    if (!items.length) throw new Error("feed had no readable items");
    html = render(items.slice(0, ITEM_COUNT), feed);
    console.log(`${feed.name}: built ${Math.min(items.length, ITEM_COUNT)} items.`);
  } catch (err) {
    failures.push(`${feed.name}: ${err.message}`);
    console.warn(`::warning::${feed.name} failed: ${err.message}`);
    html = await getLiveCopy(feed);
    console.warn(
      html
        ? `${feed.name}: reusing the last live copy.`
        : `${feed.name}: no live copy available, page not published.`
    );
  }
  if (!html) continue;
  const dir = feed.slug ? `site/${feed.slug}` : "site";
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/index.html`, html);
  pagesWritten++;
}

// Read by the workflow's last step to flag the run as failed.
if (failures.length) await writeFile("build-failures.txt", failures.join("\n") + "\n");

if (!pagesWritten) {
  console.error("Nothing to publish.");
  process.exit(1);
}
