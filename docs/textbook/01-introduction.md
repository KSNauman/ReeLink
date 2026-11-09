# Chapter 1: Introduction

## 1.1 The problem

On Instagram, creators often hold back the thing they are promoting. A Reel says *"Comment ROADMAP and I'll DM you the link"* or *"Follow me and comment AGENT"*. An automation tool on the creator's side, such as ManyChat, watches for that comment and sends the link by DM.

For one Reel that is a small chore. For twenty, it is annoying, and doing it from your personal account has costs: you end up following dozens of strangers, your comment history fills up with keywords, and your inbox fills up with marketing messages.

## 1.2 The solution

ReelLink separates the two jobs across two accounts:

| Account | Who uses it | What it does |
|---|---|---|
| **Your personal account** (`@ksydn_`) | You, on your phone | Browses Instagram and shares interesting Reels to the bot |
| **The bot account** | ReelLink, through a browser | Receives the shares, follows the creators, posts the comments, receives the creators' DMs |

Your workflow becomes:

1. During the day, tap **Share** on a Reel and send it to the bot account.
2. When you are ready, open ReelLink on your Windows PC and click **Start batch**.
3. For each new Reel, ReelLink follows the creator, comments their keyword, and records it.
4. Later, check the bot account's inbox for the links creators sent.
5. After 48 hours, click **Unfollow eligible** to clean up.

ReelLink does not read creators' replies or forward them. That was removed on purpose ([Chapter 2](02-project-history.md)). It only does the follow and the comment.

## 1.3 A walk through one Reel

Say you shared a Reel whose caption says *"Follow me and comment AGENT to get the code"*.

1. You click **Start batch**. The window asks the core to begin.
2. An Edge window opens, already signed in as the bot (the login is saved).
3. ReelLink opens the inbox and finds your chat by its display name.
4. Inside the chat it reads the other person's real `@handle` and checks that it is `ksydn_`. If it is anyone else, it stops there.
5. It finds the shared Reel card, clicks it to learn the Reel's shortcode, and adds a job to the SQLite database.
6. It opens `instagram.com/p/<shortcode>/` and reads the creator's name and the caption.
7. From the caption it extracts the keyword `AGENT`. If there were no clear keyword it would use 🙌.
8. It opens the creator's profile, clicks **Follow**, and waits until the button really says **Following** or **Requested**.
9. It opens the Reel again, types `AGENT`, posts it, and checks the comment went through.
10. It marks the job `COMPLETED`, waits 5 to 7 seconds, and moves to the next Reel.
11. When the queue is empty, the browser closes. Nothing keeps running.

## 1.4 The five buttons

The entire product is five controls ([Chapter 6](06-user-interface.md)):

| Button | What it does |
|---|---|
| **Start batch** | Scan the chat for new Reels, then follow + comment each one |
| **Stop** | Stop after the Reel in progress (only visible during a batch) |
| **Unfollow eligible (48h+)** | Unfollow creators followed at least 48 hours ago |
| **Force unfollow all** | Unfollow every tracked creator, including recent ones. Asks to confirm |
| **Log in** | Open a visible browser so you can sign in to the bot account |

Only one of these can run at a time, because they all share one browser.

## 1.5 Core principles

These ideas explain most of the design:

1. **Nothing runs unless you click.** There is no background service, no timer and no polling. Close the window and the app is gone.
2. **Never guess who to act on.** If the sender's identity or the creator's name can't be read, the Reel is skipped.
3. **Verify, don't assume.** A follow counts only when the button changes. Failing to verify stops the comment.
4. **Follow first, always.** Many creator bots only reply to followers, so a comment is never posted before the follow is confirmed.
5. **Everything is recorded locally.** All state is in one SQLite file on your PC. No server and no cloud.
6. **A safe rehearsal mode exists.** Simulation mode runs the whole flow without posting anything.

## 1.6 What ReelLink is not

- It is **not a multi-user product**. The owner's handle is hardcoded. To use it for another person you change the code and rebuild.
- It does **not use an Instagram API**. It drives a real browser, so it can break when Instagram changes its pages.
- It is **not allowed by Instagram's terms**. Automating follows and comments breaks them, and the bot account can be rate-limited or banned. Using a separate bot account limits that risk to the bot. See [Chapter 13](13-security-and-safety.md).

## 1.7 Vocabulary you need now

| Word | Meaning |
|---|---|
| **Reel** | A short Instagram video |
| **Shortcode** | The ID in a Reel's URL, e.g. `DdRTNlBSAVB` in `instagram.com/reel/DdRTNlBSAVB/` |
| **Batch** | One run of scanning and processing, started by clicking Start |
| **Job** | One Reel to process; one row in the `jobs` table |
| **Owner** | You, `@ksydn_`, the only sender ReelLink obeys |
| **Bot account** | The Instagram account ReelLink signs in to |
| **Creator** | The person who posted the Reel |
| **Keyword** | The word the caption asks you to comment |

The full list is in [Chapter 22](22-glossary.md).
