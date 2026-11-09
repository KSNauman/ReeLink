# Chapter 9: Reading Reels

Files: [`extract-reel.js`](../../src/pipeline/extract-reel.js), `extractCreatorRequirements` in [`creator-interaction.js`](../../src/pipeline/creator-interaction.js)

For each Reel, two questions need answers: **Who made it?** and **What should we comment?**

## 9.1 Getting creator and caption

`fetchReelPublicData(reelUrl, browserSession)` opens:

```
https://www.instagram.com/p/<shortcode>/
```

It uses `/p/` instead of `/reel/` deliberately. The code comment explains that `/reel/` links now redirect to a scrolling feed with many Reels on one page, so reading that page risks picking up a different Reel's data.

Then it tries sources from most to least reliable, and stops once it has both values:

| Order | Source | Provides |
|---|---|---|
| 1 | `<script type="application/ld+json">` structured data | caption, author |
| 2 | `og:description` / description meta tag | caption, creator |
| 3 | `og:title` / page title | creator |
| 4 | First profile link inside `<main>` | creator |
| 5 | `h1` or similar | caption only |

Step 4 skips reserved paths (`reel`, `reels`, `p`, `explore`, `direct`, `accounts`, `popular`, `stories`) and the bot's own account. Limiting it to `<main>` prevents picking up your own profile from the sidebar.

If everything fails, the creator is empty and `processJob` marks the job `FAILED`.

### `parseOgDescription`

Instagram uses two formats. Tested results:

| Input | Creator | Caption |
|---|---|---|
| `Comment GUIDE for it - @some.creator on November 7, 2026` | `some.creator` | `Comment GUIDE for it` |
| `348 likes, 12 comments - some.creator on March 3, 2025: "Comment GUIDE"` | `some.creator` | `Comment GUIDE` |
| `no format here` | *(empty, never invented)* | `no format here` |

## 9.2 `parseReelMetadata`

Builds a structured result: `creator`, `caption`, `hashtags`, `externalUrls`, `directResourceUrls`, `ctaKeyword`, plus two Era 1 fields (`hasDirectResource`, `needsMediaInspection`) that nothing uses now.

## 9.3 Keyword extraction

```js
extractCreatorRequirements(caption, ocrText, { defaultToEmoji: true })
```

Despite the old `ocrText` argument (always `''` now), this only reads the caption.

### Patterns, in order

| # | Pattern | Matches |
|---|---|---|
| 1 | word in `"` `'` or curly quotes | `Comment "GUIDE"` |
| 2 | word in `[ ]` | `Comment [GUIDE]` |
| 3 | after a colon | `Comment: GUIDE` |
| 4 | word followed by context | `Comment DOCKER below`, `drop X to get` |
| 5 | Step-2 phrasing | `Step 2: comment ROADMAP` |
| 6 | **any** next word | `comment DOCKER` |

The verbs are `comment`, `drop`, and for the first three also `reply`. Keywords are 2 to 30 characters of letters, digits, `_` or `-`. **Original capitalisation is kept**, because creator bots may be case-sensitive.

### The noise list

To avoid taking generic words as keywords, these are rejected:

`below, down, here, link, this, reel, post, comment, video, guide, more, info, details, free, dm, dms, now, yes, please, just, the, a, an, to, for, and, with`

**Exception:** a word in quotes or brackets is explicit, so it is accepted even if on the list.

### Results from the real function

| Caption | Comment posted | Why |
|---|---|---|
| `Follow me and comment AGENT to get the code` | `AGENT` | Pattern 4 |
| `Step 2: comment ROADMAP` | `ROADMAP` | Pattern 5 |
| `comment: Python` | `Python` | Pattern 3 |
| `Comment "link" for the repo` | `link` | Quoted, so accepted |
| `Comment for the link` | 🙌 | Asks for a comment, no keyword |
| `Just a nice sunset` | 🙌 | Nothing asked |
| `DM me for access` | 🙌 | Unclear, so the default |
| `Comment GUIDE below and I will send it` | 🙌 | **`guide` is on the noise list** |
| `Comment your thoughts below` | `your` | **Pattern 6 false positive** |
| `Drop a comment if you agree` | `if` | **Pattern 6 false positive** |

The last three are real weaknesses, covered as issues A1 and A2 in [Chapter 18](18-known-issues-and-dead-code.md).

### The return value

```js
{ requiresFollow, requiresComment, interactionType, keyword, isUnclear, reason }
```

`interactionType` is one of `none`, `comment_only`, `follow_only`, `follow_and_comment`, `unclear`. `requiresFollow` is calculated, but the app **always follows anyway** (see Chapter 10).

## 9.4 Final decision

In `processJob`:

```js
const reqs = extractCreatorRequirements(caption, '', { defaultToEmoji: true });
const keyword = (reqs.keyword && reqs.keyword.trim().length > 0 && !reqs.isUnclear)
  ? reqs.keyword.trim() : '🙌';
```

`executeCreatorWorkflow` then parses the caption again, without `defaultToEmoji`, and applies its own 🙌 fallback. The two calculations reach the same keyword, so the duplication is harmless but unnecessary.

## 9.5 Why 🙌?

Earlier designs paused for human review when a keyword was unclear. For a batch tool that defeats the purpose. A friendly emoji still follows the workflow and isn't spammy.

## 9.6 How to test keyword changes

Add cases to [`test-creator-requirements.js`](../../tests/unit/test-creator-requirements.js) or `test-extract-reel.js`, then run:

```powershell
node --test tests/unit/test-creator-requirements.js
```
