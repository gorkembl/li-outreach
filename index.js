// index.js
// Entry point. Runs once per invocation (called by GitHub Actions cron every 30 min).

import 'dotenv/config';
import { initSheets, ensureSchema, getAllLeads, getAllLists, getListById, updateLead, logAction, logConversation } from './sheets.js';
import { initConnectSafely, fetchProfile, fetchProfilePosts, viewProfile, follow, likePost, commentOnPost, sendConnectionRequest, checkConnectionStatus, sendMessage, getRecentConversations, recordRateLimit } from './connectsafely.js';
import { initClaude, extractContext, generateComment, generateDM } from './claude.js';
import { decideNextAction, computeNextActionAt, statusAfterAction } from './stateMachine.js';
import { SEQUENCE, LIMITS, FLAGS, CRITERIA } from './config.js';

async function main() {
  console.log('=== li-outreach run started', new Date().toISOString(), '===');

  // ---- Initialize all clients ----
  await initSheets();
  await ensureSchema();

  if (FLAGS.init_sheet_only) {
    console.log('init-sheet-only flag set; exiting after schema ensure.');
    return;
  }

  initConnectSafely();
  initClaude();

  // ---- Poll for new replies first (so we can pause those sequences) ----
  await pollReplies();

  // ---- Fetch all data ----
  const allLeads = await getAllLeads();
  const allLists = await getAllLists();
  const listById = Object.fromEntries(allLists.map(l => [l.list_id, l]));

  console.log(`[main] ${allLeads.length} total leads, ${allLists.length} lists`);

  // ---- Daily counters ----
  let actionsToday = 0;       // total across all
  let newLeadsToday = 0;      // qualified today

  const now = new Date();

  // ---- Shuffle leads for fairness ----
  const shuffled = [...allLeads].sort(() => Math.random() - 0.5);

  for (const lead of shuffled) {
    if (actionsToday >= LIMITS.daily_total_actions) {
      console.log('[main] daily action budget reached, stopping');
      break;
    }

    const plan = decideNextAction(lead, now);
    if (!plan) continue;

    // Enforce new-lead-per-day cap
    if (plan.action === 'qualify') {
      if (newLeadsToday >= LIMITS.daily_new_leads) continue;
    }

    const list = listById[lead.list_id];
    if (!list && plan.action !== 'qualify') {
      console.warn(`[main] lead ${lead.lead_id} has unknown list_id ${lead.list_id}`);
      continue;
    }
    if (list && list.active && list.active.toString().toLowerCase() === 'false') {
      // List paused
      continue;
    }

    try {
      await executeAction(lead, list, plan);
      actionsToday++;
      if (plan.action === 'qualify') newLeadsToday++;

      // Sleep between actions for human-like cadence
      await sleep(LIMITS.min_seconds_between_actions * 1000 + Math.random() * 60_000);
    } catch (e) {
      console.error(`[main] error on lead ${lead.lead_id} action ${plan.action}:`, e.message);
      lead.status = 'error';
      lead.notes = `[${new Date().toISOString()}] ${plan.action} failed: ${e.message}\n${lead.notes || ''}`;
      await updateLead(lead);
      await logAction(lead.lead_id, plan.action, 'error', e.message);
    }
  }

  console.log(`=== run complete: ${actionsToday} actions, ${newLeadsToday} new leads qualified ===`);
}

// ---- Execute a single planned action ----
async function executeAction(lead, list, plan) {
  console.log(`[exec] ${lead.lead_id} (${lead.name || lead.profile_url}) -> ${plan.action}`);

  if (FLAGS.dry_run) {
    await logAction(lead.lead_id, plan.action, 'success', '[DRY RUN]');
    return;
  }

  switch (plan.action) {
    case 'qualify':
      return await actionQualify(lead, list);
    case 'start_sequence':
      return await actionStartSequence(lead, list);
    case 'view':
      return await actionView(lead, plan);
    case 'follow':
      return await actionFollow(lead, plan);
    case 'like':
      return await actionLike(lead, list, plan);
    case 'comment':
      return await actionComment(lead, list, plan);
    case 'connect':
      return await actionConnect(lead, plan);
    case 'check_connection':
      return await actionCheckConnection(lead, plan);
    case 'dm':
      return await actionDM(lead, list, plan, false);
    case 'follow_up':
      return await actionDM(lead, list, plan, true);
    case 'drop':
      return await actionDrop(lead, plan.reason);
    default:
      throw new Error(`unknown action: ${plan.action}`);
  }
}

// ---- Action handlers ----

async function actionQualify(lead, list) {
  lead.status = 'qualifying';
  await updateLead(lead);

  const profileRes = await fetchProfile(lead.profile_url);
  recordRateLimit(profileRes.rateLimit);
  const profile = profileRes.data;

  const postsRes = await fetchProfilePosts(lead.profile_url, 10);
  recordRateLimit(postsRes.rateLimit);
  const posts = postsRes.data.posts || postsRes.data || [];

  const ctx = await extractContext(profile, posts);

  // Skip if qualification says so
  if (ctx.skip_reason) {
    lead.status = 'skipped';
    lead.notes = `Skipped: ${ctx.skip_reason}`;
    await updateLead(lead);
    await logAction(lead.lead_id, 'qualify', 'skipped', ctx.skip_reason);
    return;
  }

  lead.name = profile.name || lead.name;
  lead.headline = profile.headline || lead.headline;
  lead.linkedin_id = profile.linkedin_id || profile.id || '';
  lead.timezone = ctx.inferred_timezone || lead.timezone || 'UTC';
  lead.personalization_context = JSON.stringify(ctx);
  lead.status = 'qualified';
  lead.qualified_at = new Date().toISOString();
  lead.sequence_step = -1;
  lead.last_action = 'qualify';
  lead.last_action_at = new Date().toISOString();

  await updateLead(lead);
  await logAction(lead.lead_id, 'qualify', 'success', `themes=${ctx.themes?.join('|')}, tz=${ctx.inferred_timezone}`);
}

async function actionStartSequence(lead, list) {
  // Just schedule the first step (don't execute it yet)
  const firstStep = SEQUENCE[0];
  const qualifiedAt = new Date(lead.qualified_at);
  const nextAt = computeNextActionAt(qualifiedAt, firstStep, lead);

  lead.status = 'viewing';
  lead.phase = String(firstStep.phase);
  lead.next_action_at = nextAt.toISOString();

  await updateLead(lead);
  await logAction(lead.lead_id, 'start_sequence', 'success', `first action at ${nextAt.toISOString()}`);
}

async function actionView(lead, plan) {
  const res = await viewProfile(lead.profile_url);
  recordRateLimit(res.rateLimit);
  await advanceLead(lead, plan, 'view');
  await logAction(lead.lead_id, 'view', 'success');
}

async function actionFollow(lead, plan) {
  const res = await follow(lead.profile_url);
  recordRateLimit(res.rateLimit);
  await advanceLead(lead, plan, 'follow');
  await logAction(lead.lead_id, 'follow', 'success');
}

async function actionLike(lead, list, plan) {
  // Get fresh posts and pick the most recent one we haven't engaged on
  const postsRes = await fetchProfilePosts(lead.profile_url, 5);
  recordRateLimit(postsRes.rateLimit);
  const posts = postsRes.data.posts || postsRes.data || [];
  if (!posts.length) throw new Error('no posts available to like');

  // Pick a recent post (rotation could be smarter; for v1, take latest)
  const target = posts[0];
  const postUrn = target.urn || target.post_urn || target.id;
  if (!postUrn) throw new Error('post URN not found in response');

  const res = await likePost(postUrn);
  recordRateLimit(res.rateLimit);
  await advanceLead(lead, plan, 'like');
  await logAction(lead.lead_id, 'like', 'success', `post=${postUrn}`);
}

async function actionComment(lead, list, plan) {
  const postsRes = await fetchProfilePosts(lead.profile_url, 5);
  recordRateLimit(postsRes.rateLimit);
  const posts = postsRes.data.posts || postsRes.data || [];
  if (!posts.length) throw new Error('no posts available to comment on');

  const target = posts[0];
  const postUrn = target.urn || target.post_urn || target.id;
  if (!postUrn) throw new Error('post URN not found');

  const ctx = typeof lead.personalization_context === 'string'
    ? JSON.parse(lead.personalization_context || '{}')
    : (lead.personalization_context || {});
  lead.personalization_context = ctx;

  const commentText = await generateComment(lead, list, target);
  const res = await commentOnPost(postUrn, commentText);
  recordRateLimit(res.rateLimit);
  await advanceLead(lead, plan, 'comment');
  await logAction(lead.lead_id, 'comment', 'success', `text=${commentText.slice(0, 80)}...`);
}

async function actionConnect(lead, plan) {
  // Send connection request without a note (statistically better acceptance)
  const res = await sendConnectionRequest(lead.profile_url);
  recordRateLimit(res.rateLimit);

  lead.status = 'connecting';
  lead.phase = String(plan.step.phase);
  lead.sequence_step = String(plan.stepIdx);
  lead.last_action = 'connect';
  lead.last_action_at = new Date().toISOString();
  // Set next check in 2 days
  lead.next_action_at = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
  await updateLead(lead);
  await logAction(lead.lead_id, 'connect', 'success');
}

async function actionCheckConnection(lead, plan) {
  const res = await checkConnectionStatus(lead.profile_url);
  recordRateLimit(res.rateLimit);
  const status = (res.data.status || res.data.connection_status || '').toLowerCase();

  if (status === 'connected' || status === 'accepted' || status === '1st') {
    // Move to connected, schedule next step
    lead.status = 'connected';
    // Find the post-connect step (next in sequence after connect)
    const connectIdx = SEQUENCE.findIndex(s => s.action === 'connect');
    const nextStep = SEQUENCE[connectIdx + 1];
    if (nextStep) {
      const qualifiedAt = new Date(lead.qualified_at);
      lead.next_action_at = computeNextActionAt(qualifiedAt, nextStep, lead).toISOString();
      lead.sequence_step = String(connectIdx);
    }
    await updateLead(lead);
    await logAction(lead.lead_id, 'check_connection', 'success', 'accepted');
  } else {
    // Still pending — schedule another check
    lead.next_action_at = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    await updateLead(lead);
    await logAction(lead.lead_id, 'check_connection', 'success', `still ${status}`);
  }
}

async function actionDM(lead, list, plan, isFollowUp) {
  const ctx = typeof lead.personalization_context === 'string'
    ? JSON.parse(lead.personalization_context || '{}')
    : (lead.personalization_context || {});
  lead.personalization_context = ctx;

  const text = await generateDM(lead, list, isFollowUp);
  const res = await sendMessage(lead.profile_url, text);
  recordRateLimit(res.rateLimit);

  await advanceLead(lead, plan, isFollowUp ? 'follow_up' : 'dm');
  await logConversation(lead.lead_id, 'outgoing', 'dm', text, false);
  await logAction(lead.lead_id, isFollowUp ? 'follow_up' : 'dm', 'success', `chars=${text.length}`);
}

async function actionDrop(lead, reason) {
  lead.status = 'dropped';
  lead.notes = `Dropped: ${reason}\n${lead.notes || ''}`;
  await updateLead(lead);
  await logAction(lead.lead_id, 'drop', 'success', reason);
}

// ---- Helper: advance lead to next step in sequence ----
async function advanceLead(lead, plan, actionName) {
  const newStatus = statusAfterAction(actionName);
  if (newStatus) lead.status = newStatus;
  lead.phase = String(plan.step.phase);
  lead.sequence_step = String(plan.stepIdx);
  lead.last_action = actionName;
  lead.last_action_at = new Date().toISOString();

  // Schedule next step
  const nextStep = SEQUENCE[plan.stepIdx + 1];
  if (nextStep) {
    const qualifiedAt = new Date(lead.qualified_at);
    lead.next_action_at = computeNextActionAt(qualifiedAt, nextStep, lead).toISOString();
  } else {
    lead.next_action_at = '';
  }
  await updateLead(lead);
}

// ---- Reply polling ----
async function pollReplies() {
  try {
    // Get last 24h of conversations
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const res = await getRecentConversations(since);
    recordRateLimit(res.rateLimit);
    const conversations = res.data.conversations || res.data || [];

    if (!conversations.length) return;

    const allLeads = await getAllLeads();
    const leadsByLinkedinId = {};
    const leadsByUrl = {};
    allLeads.forEach(l => {
      if (l.linkedin_id) leadsByLinkedinId[l.linkedin_id] = l;
      if (l.profile_url) leadsByUrl[normalizeUrl(l.profile_url)] = l;
    });

    for (const conv of conversations) {
      // Find incoming messages we haven't seen yet
      const msgs = conv.messages || [];
      for (const m of msgs) {
        if (m.direction !== 'incoming' && m.is_from_user !== true) continue;
        const senderId = m.sender_id || conv.participant_id;
        const senderUrl = m.sender_url || conv.participant_url;
        const lead = leadsByLinkedinId[senderId] || leadsByUrl[normalizeUrl(senderUrl || '')];
        if (!lead) continue;

        // Mark as replied and stop sequence
        if (lead.status !== 'replied') {
          lead.status = 'replied';
          lead.response_received = 'true';
          lead.next_action_at = '';
          await updateLead(lead);
          await logConversation(lead.lead_id, 'incoming', 'dm', m.text || m.body || '', true);
          await logAction(lead.lead_id, 'reply_received', 'success', (m.text || '').slice(0, 100));
          console.log(`[poll] REPLY from ${lead.name || lead.profile_url}`);
        }
      }
    }
  } catch (e) {
    console.error('[poll] error:', e.message);
  }
}

function normalizeUrl(url) {
  return (url || '').replace(/\/$/, '').toLowerCase();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---- Run ----
main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
