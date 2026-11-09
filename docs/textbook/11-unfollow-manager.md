# Chapter 11: The unfollow manager and the 48-hour rule

Code: `unfollow()` in [`src/app.js`](../../src/app.js), `getFollowedCreatorsForUnfollow` in [`src/queue/jobs.js`](../../src/queue/jobs.js), `unfollowCreatorDirect` in [`src/instagram/inbox.js`](../../src/instagram/inbox.js)

## 11.1 Why this exists

The bot follows a new creator for almost every Reel, so its following list grows quickly. It needs cleaning up, but not too soon.

The 48-hour window exists for two reasons, per the old README:

- Unfollowing immediately after commenting looks like spam behaviour.
- Creator bots may need the follow to still exist when they deliver the link.

The constant:

```js
const UNFOLLOW_MIN_AGE_HOURS = 48;
```

## 11.2 Sorting creators

`getFollowedCreatorsForUnfollow({ minAgeHours: 48 })` returns:

```js
{ eligible: [...], protected: [...], all: [...] }
```

Each entry has `creator`, `isLive`, `isSimulated`, `followedAt`, `ageHours`, `ageDays`, `remainingHours`, `isEligible`.

| Group | Rule |
|---|---|
| **eligible** | `ageHours >= 48` |
| **protected** | `ageHours < 48` |

`ageHours` is rounded down, so 47 hours 59 minutes is still protected.

The source is `getDetailedFollowedCreatorsToday()`. Despite the name, it returns **all** tracked follows, not just today's. It skips rows marked `UNFOLLOWED`, and merges several Reels from one creator into a single entry. When a creator has several live follows, the **oldest** timestamp is used, because that is when the follow really began.

## 11.3 The two buttons

| Button | Targets | Confirmation |
|---|---|---|
| **Unfollow eligible (48h+)** | `eligible` | Standard |
| **Force unfollow all** | `all` | Strong ⚠️ warning |

The rule that protects recent follows:

```js
const forceAll = options.forceAll === true;
const targets = forceAll ? data.all : data.eligible;
```

Recent follows are safe unless `forceAll` is exactly `true`.

**A bug that was fixed here.** The old HTTP handler used `(forceAll || data.eligible.length === 0) ? data.all : data.eligible`. If nobody was eligible yet, it unfollowed *everyone*, protected or not. The new version does nothing and says so:

> Nothing to unfollow yet: 3 creator(s) are still inside the 48-hour window.

## 11.4 One unfollow

`unfollowCreatorDirect(creator)`:

1. Simulation: mark in the database and return.
2. Open the profile, wait 2.5 s.
3. Find the `Following` button in the header. If absent, mark as unfollowed and return.
4. Click it. A dialog appears.
5. Find the exact text `Unfollow` in the dialog and click it.
6. Wait 2 s, mark in the database.

There is a 1.2 s pause between creators, and the browser closes at the end.

`markCreatorUnfollowed()` updates every row for that creator:

```sql
UPDATE creator_interactions
SET follow_status = 'UNFOLLOWED', simulated_follow_status = 'UNFOLLOWED',
    live_follow_verified_at = NULL, follow_verified_at = NULL, updated_at = datetime('now')
WHERE LOWER(creator_username) = ?
```

If you later share another Reel by that creator, a new row is created and they are followed again.

## 11.5 Known gaps

- If the confirmation dialog isn't found, the creator is still recorded as unfollowed and counted as success (issue A4).
- Simulated follows are listed together with real ones (issue B3).

See [Chapter 18](18-known-issues-and-dead-code.md).

## 11.6 Tests

[`test-two-day-unfollow.js`](../../tests/unit/test-two-day-unfollow.js) covers segmentation, and that `app.unfollow()` respects protection unless `forceAll` is set.
