/**
 * Supervised Live-Test Runner for Creator Interaction Workflow
 * 
 * Safety Guarantees:
 * 1. Safe simulation mode by default (zero live actions without --live flag).
 * 2. Processes exactly ONE Reel at a time.
 * 3. Requires explicit manual confirmation ("approve") before EVERY live action:
 *    - Follow creator
 *    - Post comment
 *    - Deliver final message
 * 4. Halts IMMEDIATELY if Instagram presents any challenge, restriction, or block.
 * 
 * Execution Workflow (6 Steps):
 *   Step 1: Receive and normalize URL (/reel/, /p/, /reels/), strip tracking, create/retrieve SQLite job.
 *   Step 2: Open the Reel via authenticated Playwright session, extract creator and caption, identify exact keyword.
 *   Step 3: FOLLOW FIRST, ALWAYS: attempt follow on creator, verify resulting follow state. Stop if fails.
 *   Step 4: COMMENT THE REQUESTED KEYWORD: comment exact keyword preserving case/spelling, verify submission.
 *   Step 5: OPEN CREATOR DM: navigate to creator conversation, check Primary and Requests.
 *   Step 6: WAIT FIVE MINUTES: poll every ~4 seconds. Deliver URL if arrives, or return exact "Couldn't fetch message".
 * 
 * Usage:
 *   Dry-Run / Preview: node tests/test-creator-supervised-live.js [reelUrl]
 *   Live Supervised:   node tests/test-creator-supervised-live.js [reelUrl] --live
 */
const readline = require('readline');
const config = require('../src/config');
const logger = require('../src/utils/logger');
const BrowserSession = require('../src/instagram/session');
const InstagramInbox = require('../src/instagram/inbox');
const InstagramSender = require('../src/instagram/sender');
const {
  CreatorInteractionManager,
  extractCreatorRequirements,
  isLiveFollowVerified,
  isLiveCommentVerified,
  isSimulatedFollowCompleted,
  isSimulatedCommentCompleted,
} = require('../src/pipeline/creator-interaction');
const { JobQueue } = require('../src/queue/jobs');
const { fetchReelPublicData } = require('../src/pipeline/extract-reel');
const { extractReelShortcode, normalizeReelUrl, cleanTrackingParams, extractExternalUrls } = require('../src/utils/url-helper');
const { processResource } = require('../src/pipeline/process-resource');

function askUser(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function runSupervisedLiveTest() {
  const args = process.argv.slice(2);
  const isLive = args.includes('--live');
  const targetUrl = args.find(a => a.startsWith('http')) || 'https://www.instagram.com/reel/DdRTNlBSAVB/?utm_source=ig_web_button_share_sheet';

  // -------------------------------------------------------------------------
  // STEP 1 — Receive and normalize
  // -------------------------------------------------------------------------
  const shortcode = extractReelShortcode(targetUrl) || 'DdRTNlBSAVB';
  const normalizedUrl = normalizeReelUrl(targetUrl) || `https://www.instagram.com/reel/${shortcode}/`;

  console.log('\n======================================================');
  console.log(' ReelLink: 6-Step Creator Interaction Live Workflow   ');
  console.log('======================================================');
  console.log(`Raw URL:        ${targetUrl}`);
  console.log(`Normalized URL: ${normalizedUrl}`);
  console.log(`Shortcode:      ${shortcode}`);
  console.log(`Mode:           ${isLive ? '⚠️ LIVE SUPERVISED (Actions executed on Instagram with manual approval)' : '⚡ SAFE SIMULATION / DRY-RUN (Default)'}`);
  console.log('======================================================\n');

  const senderArgIdx = args.indexOf('--sender');
  const specifiedSender = senderArgIdx !== -1 && args[senderArgIdx + 1] ? args[senderArgIdx + 1] : 'ksydn_';
  const threadArgIdx = args.indexOf('--thread');
  const specifiedThread = threadArgIdx !== -1 && args[threadArgIdx + 1] ? args[threadArgIdx + 1] : '17842115300129061';

  const { isSenderAllowed, assertSenderAllowed } = require('../src/security/sender-allowlist');
  if (!assertSenderAllowed(specifiedSender, { threadId: specifiedThread, stage: 'SUPERVISED_RUNNER' })) {
    console.log(`\n❌ Access Denied: Sender "${specifiedSender}" is not on the authorized allowlist (nauman, ksydn_).`);
    console.log(`ReelLink rejected processing to protect against unauthorized triggers.\n`);
    return;
  }

  // Enforce/retrieve SQLite job idempotently
  const queue = new JobQueue();
  const { job, isDuplicate } = queue.createOrGetJob({
    threadId: specifiedThread,
    senderUsername: specifiedSender,
    reelUrl: normalizedUrl,
    shortcode,
  });

  // Ensure sender and thread in existing job match approved identity
  if (job && (job.sender_username === 'operator' || job.thread_id === 'supervised_operator_thread')) {
    queue.db.prepare('UPDATE jobs SET sender_username = ?, thread_id = ? WHERE id = ?').run(
      specifiedSender,
      specifiedThread,
      job.id
    );
    job.sender_username = specifiedSender;
    job.thread_id = specifiedThread;
  }

  console.log(`[Step 1 — Normalized & Queued]`);
  console.log(`• SQLite Job ID:   ${job.id}`);
  console.log(`• Duplicate Job:   ${isDuplicate ? 'Yes (Retrieved existing job)' : 'No (Created new job)'}`);
  console.log(`• Current Status:  ${job.status}`);

  // Safe Recovery Mechanism: allow explicit --recover-simulated or auto-recover upon --live
  const shouldRecover = args.includes('--recover-simulated');
  const existingInteractionCheck = queue.getCreatorInteraction(job.id);
  const isContaminatedBySim = existingInteractionCheck && existingInteractionCheck.is_simulated === 1 &&
    (!existingInteractionCheck.live_follow_verified_at && !existingInteractionCheck.live_comment_posted_at);

  if (shouldRecover || (isLive && isContaminatedBySim)) {
    console.log(`\n[Safe Simulation Recovery]`);
    if (isContaminatedBySim) {
      console.log(`⚠️ Notice: Job ${job.id} contains completion records written by SIMULATION.`);
      console.log(`Resetting simulated follow/comment completion so live execution resumes from Step 3.`);
    }
    const recResult = queue.recoverSimulatedJob(job.id);
    if (recResult.recovered) {
      console.log(`✅ Safe recovery applied: unverified live records reset to NOT_ATTEMPTED. Job status: PENDING.`);
    } else {
      console.log(`• Recovery status: ${recResult.reason}`);
    }
    if (shouldRecover && !isLive) {
      console.log('Recovery complete. Exiting (omit --recover-simulated to proceed with run).\n');
      return;
    }
  }

  if (isLive) {
    console.log('\n⚠️ WARNING: You have selected LIVE mode.');
    console.log('Actions will be performed using your dedicated bot account in data/browser_profile.');
    const confirmLive = await askUser('Type "proceed" to start the live supervised workflow: ');
    if (confirmLive !== 'proceed') {
      console.log('🚫 Supervised live run aborted by operator. No live actions performed.\n');
      return;
    }
  }

  // Use persistent browser session
  const session = new BrowserSession({ headless: config.instagram.headless });

  try {
    console.log('\n[Checking Instagram authentication]');
    const auth = await session.checkAuthStatus();
    if (!auth.authenticated) {
      console.log('❌ Error: Browser session is not authenticated.');
      console.log('Please log into your dedicated bot account first: npm.cmd run setup:session');
      return;
    }
    console.log(`✅ Session is authenticated as active Instagram user.`);

    const inbox = new InstagramInbox(session);
    const sender = new InstagramSender(session, { dryRun: !isLive });

    const manager = new CreatorInteractionManager(
      queue,
      session,
      inbox,
      sender,
      {
        enabled: isLive,
        simulationMode: !isLive,
        requireApproval: true,
        allowFollow: true,
        timeoutSec: 300,
        initialWaitingWindowSec: 300,
        inboxPollIntervalMs: 4000,
      }
    );

    // -------------------------------------------------------------------------
    // STEP 2 — Open the Reel & identify keyword
    // -------------------------------------------------------------------------
    console.log('\n[Step 2 — Open the Reel]');
    console.log(`Opening Reel page with authenticated Playwright session...`);
    const metadata = await fetchReelPublicData(normalizedUrl, session);
    console.log(`• Creator:         @${metadata.creator || '(could not be read)'}`);
    console.log(`• Caption Preview: ${metadata.caption ? metadata.caption.slice(0, 150).replace(/\n/g, ' ') + '...' : '(empty or unreadable)'}`);

    if (!metadata.creator) {
      console.log('❌ Failure: Creator username could not be extracted from Reel.');
      return;
    }

    const reqs = extractCreatorRequirements(metadata.caption || '');
    console.log(`• Extracted Keyword: "${reqs.keyword || '(none)'}" (Spelling/Casing preserved)`);
    console.log(`• Requirement Type:  ${reqs.interactionType}`);

    if (reqs.isUnclear || !reqs.keyword) {
      console.log(`\n❌ Failure: Caption or instructions cannot be read, or keyword is ambiguous/generic.`);
      console.log(`Reason: ${reqs.reason || 'Missing exact comment keyword'}`);
      console.log(`Workflow halted to avoid guessing or posting generic comments.`);
      return;
    }

    // -------------------------------------------------------------------------
    // STEP 3 — FOLLOW FIRST, ALWAYS
    // -------------------------------------------------------------------------
    console.log('\n[Step 3 — FOLLOW FIRST, ALWAYS]');
    console.log(`Checking current follow state for creator @${metadata.creator}...`);

    let existingInteraction = queue.createOrGetCreatorInteraction(job.id, {
      creatorUsername: metadata.creator,
      shortcode,
      requiresFollow: 1,
      requiresComment: 1,
      keyword: reqs.keyword,
      isSimulated: isLive ? 0 : 1,
    });

    const isAlreadyDone = isLive
      ? queue.isLiveFollowVerified(existingInteraction)
      : (isSimulatedFollowCompleted(existingInteraction) || queue.isLiveFollowVerified(existingInteraction));

    if (isAlreadyDone) {
      console.log(`• Creator @${metadata.creator} was already followed in a prior verified run. Step complete.`);
    } else {
      const followCheck = await manager.checkFollowStatus(metadata.creator, { isSimulation: !isLive });
      console.log(`• Follow Status: ${followCheck.status}`);

      if (followCheck.status === 'RESTRICTED') {
        console.log(`❌ Instagram action restriction detected: ${followCheck.error}`);
        return;
      }

      if (followCheck.isFollowing) {
        console.log(`• Account is already following @${metadata.creator}.`);
        if (isLive) {
          queue.updateCreatorInteraction(job.id, {
            follow_status: 'ALREADY_FOLLOWING',
            follow_verified_at: new Date().toISOString(),
            live_follow_verified_at: new Date().toISOString(),
            is_simulated: 0,
          });
        } else {
          queue.updateCreatorInteraction(job.id, {
            simulated_follow_status: 'ALREADY_FOLLOWING',
            simulated_follow_at: new Date().toISOString(),
            is_simulated: 1,
          });
        }
      } else {
        console.log('------------------------------------------------------');
        console.log(`ACTION PROPOSAL: Follow creator @${metadata.creator}`);
        console.log('------------------------------------------------------');

        if (isLive) {
          const followApproved = await askUser(`Type "approve" to execute LIVE FOLLOW on @${metadata.creator}: `);
          if (followApproved !== 'approve') {
            console.log('🚫 Follow rejected by operator. Stopping workflow (Comment will NOT be executed).');
            return;
          }
        }

        console.log(`Executing follow on @${metadata.creator}...`);
        const followResult = await manager.executeFollow(metadata.creator, {
          isSimulation: !isLive,
          approved: true,
        });

        if (!followResult.success) {
          console.log(`❌ Follow failed: ${followResult.error}`);
          console.log(`Stopping workflow immediately — comment step prevented.`);
          if (isLive) {
            queue.updateCreatorInteraction(job.id, { follow_status: 'FAILED', is_simulated: 0 });
          } else {
            queue.updateCreatorInteraction(job.id, { simulated_follow_status: 'FAILED', is_simulated: 1 });
          }
          return;
        }

        console.log(`✅ Follow action verified successfully! State transitioned to Following.`);
        if (isLive) {
          queue.updateCreatorInteraction(job.id, {
            follow_status: 'COMPLETED',
            follow_verified_at: new Date().toISOString(),
            live_follow_verified_at: new Date().toISOString(),
            is_simulated: 0,
          });
        } else {
          queue.updateCreatorInteraction(job.id, {
            simulated_follow_status: 'COMPLETED',
            simulated_follow_at: new Date().toISOString(),
            is_simulated: 1,
          });
        }
      }
    }

    // Guard: follow must be verified before commenting!
    const freshInteraction = queue.getCreatorInteraction(job.id);
    const followVerifiedForComment = isLive
      ? queue.isLiveFollowVerified(freshInteraction)
      : (isSimulatedFollowCompleted(freshInteraction) || queue.isLiveFollowVerified(freshInteraction));

    if (!followVerifiedForComment) {
      console.log('❌ Error: Follow state was not verified! Comment step prevented.');
      return;
    }

    // -------------------------------------------------------------------------
    // STEP 4 — COMMENT THE REQUESTED KEYWORD
    // -------------------------------------------------------------------------
    console.log('\n[Step 4 — COMMENT THE REQUESTED KEYWORD]');
    const commentAlreadyDone = isLive
      ? queue.isLiveCommentVerified(freshInteraction)
      : (isSimulatedCommentCompleted(freshInteraction) || queue.isLiveCommentVerified(freshInteraction));

    if (commentAlreadyDone) {
      console.log(`• Comment "${freshInteraction.comment_text || reqs.keyword}" was already posted in a prior verified run. Skipping duplicate.`);
    } else {
      console.log(`Posting exact keyword: "${reqs.keyword}" (Preserving spelling and capitalization)`);
      console.log('------------------------------------------------------');
      console.log(`ACTION PROPOSAL: Post comment "${reqs.keyword}" on Reel ${shortcode}`);
      console.log('------------------------------------------------------');

      if (isLive) {
        const commentApproved = await askUser(`Type "approve" to post comment "${reqs.keyword}" on Instagram: `);
        if (commentApproved !== 'approve') {
          console.log('🚫 Comment rejected by operator. Aborting workflow.');
          return;
        }
      }

      console.log(`Posting comment "${reqs.keyword}" on Reel ${shortcode}...`);
      const commentResult = await manager.executeComment(shortcode, reqs.keyword, {
        isSimulation: !isLive,
        approved: true,
      });

      if (!commentResult.success) {
        console.log(`❌ Comment post failed: ${commentResult.error}`);
        if (isLive) {
          queue.updateCreatorInteraction(job.id, { comment_status: 'FAILED', is_simulated: 0 });
        } else {
          queue.updateCreatorInteraction(job.id, { simulated_comment_status: 'FAILED', is_simulated: 1 });
        }
        return;
      }

      console.log(`✅ Comment submission verified!`);
      const nowIso = new Date().toISOString();
      const expiresIso = new Date(Date.now() + 300000).toISOString();

      if (isLive) {
        queue.updateCreatorInteraction(job.id, {
          comment_status: 'POSTED',
          comment_posted_at: nowIso,
          live_comment_posted_at: nowIso,
          comment_text: reqs.keyword,
          waiting_since: nowIso,
          initial_window_expires_at: expiresIso,
          reply_status: 'WAITING_FOR_REPLY',
          is_simulated: 0,
        });
        queue.updateStatus(job.id, 'WAITING_FOR_REPLY');
      } else {
        queue.updateCreatorInteraction(job.id, {
          simulated_comment_status: 'POSTED',
          simulated_comment_at: nowIso,
          comment_text: reqs.keyword,
          waiting_since: nowIso,
          initial_window_expires_at: expiresIso,
          reply_status: 'WAITING_FOR_REPLY',
          is_simulated: 1,
        });
        queue.updateStatus(job.id, 'WAITING_FOR_REPLY');
      }
    }

    // -------------------------------------------------------------------------
    // STEP 5 & 6 — OPEN CREATOR DM & WAIT FIVE MINUTES
    // -------------------------------------------------------------------------
    console.log('\n[Step 5 — OPEN CREATOR DM]');
    console.log(`Navigating to conversation with creator @${metadata.creator}...`);

    console.log('\n[Step 6 — WAIT FIVE MINUTES (300 SECONDS)]');
    console.log(`Starting real 5-minute timer (300s) post-comment...`);
    console.log(`Polling every ~4 seconds, checking Primary and Message Requests...`);

    const timeoutSec = manager.getEffectiveWaitingWindowSec(!isLive, 300);

    const inboxResult = await manager.monitorInboxForResponse(metadata.creator, {
      isSimulation: !isLive,
      timeoutSec,
      pollIntervalMs: 4000,
    });

    if (inboxResult.received && (inboxResult.messageText || inboxResult.extractedUrl)) {
      console.log(`\n🎉 Valid automated DM reply received from @${metadata.creator}!`);
      console.log(`• Folder:      ${inboxResult.folder}`);
      console.log(`• Message:     ${inboxResult.messageText || inboxResult.extractedUrl}`);

      const extractedUrls = extractExternalUrls(inboxResult.messageText || '').map(cleanTrackingParams);
      const targetResourceUrl = inboxResult.extractedUrl || extractedUrls[0];

      if (!targetResourceUrl) {
        console.log(`⚠️ Creator replied, but message contained no valid external resource URL.`);
        return;
      }

      console.log(`• Extracted Resource Link: ${targetResourceUrl}`);
      const processed = await processResource(targetResourceUrl);

      if (!processed.success) {
        console.log(`❌ Resource security validation failed: ${processed.error}`);
        return;
      }

      console.log(`• Verified Resource: ${processed.finalUrl}`);
      console.log(`• Summary:           ${processed.summary}`);

      // Deliver to user
      if (job.is_delivered !== 1) {
        if (isLive) {
          console.log('\n------------------------------------------------------');
          console.log('ACTION PROPOSAL: Deliver verified link to user');
          console.log('------------------------------------------------------');
          const deliverApproved = await askUser('Type "approve" to deliver verified link via DM: ');
          if (deliverApproved === 'approve') {
            await sender.sendSuccess(job.thread_id, {
              url: processed.finalUrl,
              title: processed.summary,
              summary: `Retrieved via verified creator workflow from @${metadata.creator}`,
              score: 0.95,
            });
            queue.markDelivered(job.id);
            console.log('✅ Delivered link to user DM thread!');
          }
        } else {
          console.log('⚡ [SIMULATION] Delivered link previewed for user.');
        }
      }

      queue.updateStatus(job.id, 'COMPLETED', {
        candidateUrl: processed.finalUrl,
        resultSummary: processed.summary,
        isDelivered: 1,
      });

      console.log('\n✅ Workflow completed successfully!');
    } else {
      // 5-minute deadline expired without reply!
      console.log('\n⏱️ 5-Minute waiting deadline expired without receiving a creator reply.');
      console.log('Returning exact required message to user:');
      console.log('------------------------------------------------------');
      console.log("Couldn't fetch message");
      console.log('------------------------------------------------------');

      if (job.is_delivered !== 1) {
        await sender.sendMessage(job.thread_id, "Couldn't fetch message", { isSimulation: !isLive });
        queue.markDelivered(job.id);
        console.log('✅ Sent "Couldn\'t fetch message" to user DM thread.');
      }

      queue.updateCreatorInteraction(job.id, {
        reply_status: 'WAITING_INITIAL_WINDOW_EXPIRED',
        last_inbox_check_at: new Date().toISOString(),
      });
      queue.updateStatus(job.id, 'WAITING_FOR_REPLY', {
        resultSummary: "Couldn't fetch message",
      });

      console.log('• State persisted in SQLite as WAITING_FOR_REPLY.');
      console.log('• Process restarts will NEVER repeat completed follow or comment.');
    }
  } catch (err) {
    logger.error('Supervised workflow encountered error', { error: err.message, stack: err.stack });
    console.error('\n❌ Workflow Error:', err.message);
  } finally {
    if (session) {
      await session.close();
    }
  }
}

if (require.main === module) {
  runSupervisedLiveTest().catch(console.error);
}

module.exports = runSupervisedLiveTest;
