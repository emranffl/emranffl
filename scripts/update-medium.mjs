/**
 * Refreshes the "Writing" list in README.md from the Medium RSS feed.
 *
 * Deliberately dependency-free — this repo has no package.json, and adding one
 * just to pull `rss-parser` would put an install step in front of a job whose
 * whole output is five list items. Node's built-in fetch plus a narrow parse of
 * the two fields we render is enough, and it keeps the workflow to one step.
 *
 * The portfolio does the richer version of this (lead images, claps, reading
 * time) in lib/medium.ts. This is the teaser cut: title and date only.
 *
 * Exits non-zero WITHOUT touching the README when the feed is unreachable or
 * empty. Writing an empty section on a transient 503 would silently delete the
 * list and then commit that deletion, which is worse than skipping a week.
 *
 * Usage: node scripts/update-medium.mjs [username]
 */

import { readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const README = join(dirname(fileURLToPath(import.meta.url)), "..", "README.md")

/** Most recent posts kept — the section is a teaser, not an archive. */
const MAX_ARTICLES = 5

/** Markers delimiting the generated block; everything between is replaced. */
const START = "<!-- MEDIUM:START -->"
const END = "<!-- MEDIUM:END -->"

/**
 * Unwraps CDATA and decodes the handful of entities Medium actually emits.
 *
 * Not a general-purpose HTML decoder: titles are plain text in this feed, so
 * the five named entities below plus numeric refs cover it.
 *
 * @param value raw text node contents
 * @returns display-ready plain text
 */
function decodeText(value) {
  return value
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim()
}

/**
 * Reads one tag's text content out of an `<item>` block.
 *
 * @param xml   a single `<item>…</item>` slice
 * @param tag   tag name to read
 * @returns decoded contents, or "" when the tag is absent
 */
function tagText(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
  return match ? decodeText(match[1]) : ""
}

/**
 * Parses the feed into the fields the README renders.
 *
 * @param xml full RSS document
 * @returns posts, newest first, capped at {@link MAX_ARTICLES}
 */
function parseFeed(xml) {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? []

  return items
    .map((item) => {
      // - <link> carries the readable slug but an `?source=rss-…` tracking
      //   query; strip it. <guid> is only a fallback: Medium marks it
      //   isPermaLink="false" and it resolves to a bare /p/<id> URL.
      const link = tagText(item, "link").split("?")[0] || tagText(item, "guid")

      return {
        title: tagText(item, "title") || "Untitled",
        link,
        published: new Date(tagText(item, "pubDate")),
      }
    })
    .filter((post) => post.link && !Number.isNaN(post.published.valueOf()))
    .sort((a, b) => b.published - a.published)
    .slice(0, MAX_ARTICLES)
}

/**
 * Renders the markdown block placed between the markers.
 *
 * @param posts parsed feed entries
 * @returns markdown list plus the archive link
 */
function render(posts) {
  const lines = posts.map((post) => {
    const when = post.published.toLocaleDateString("en-GB", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    })
    return `- **[${post.title}](${post.link})** — ${when}`
  })

  return [...lines, "", "[All posts →](https://medium.com/@emranffl)"].join("\n")
}

const username = process.argv[2] ?? "emranffl"

const response = await fetch(`https://medium.com/feed/@${username}`, {
  headers: { accept: "application/rss+xml" },
})
if (!response.ok) {
  console.error(`Feed fetch failed: ${response.status} ${response.statusText}`)
  process.exit(1)
}

const posts = parseFeed(await response.text())
if (posts.length === 0) {
  console.error("Feed parsed to zero posts — leaving README untouched")
  process.exit(1)
}

const readme = await readFile(README, "utf8")
const block = new RegExp(`${START}[\\s\\S]*?${END}`)
if (!block.test(readme)) {
  console.error(`Markers ${START} / ${END} not found in README.md`)
  process.exit(1)
}

const updated = readme.replace(block, `${START}\n\n${render(posts)}\n\n${END}`)

if (updated === readme) {
  console.log("No change.")
} else {
  await writeFile(README, updated)
  console.log(`Updated with ${posts.length} post(s).`)
}
