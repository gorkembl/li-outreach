// index.js
// Entry point. Runs once per invocation (called by GitHub Actions cron every 30 min).

import 'dotenv/config';
import {
  initSheets, ensureSchema, getAllLeads, getAllLists, updateLead,
  logAction, logConversation,
} from './sheets.js';
import {
  initConnectSafely, extractProfileId,
  fetchProfile, fetchProfilePosts, visitProfile, followProfile,
  reactToPost, commentOnPost, sendConnectionRequest, checkRelationship,
  sendMessageWithTyping, getRecentMessages, recordRateLimit,
} from './connectsafely.js';
import { initClaude, extractContext, generateComment, generateDM } from './claude.js';
import { decideNextAction, computeNextActionAt, statusAfterAction } from './stateMachine.js';
import { SEQUENCE, LIMITS, FLAGS } from './config.js';

async function main() {
  console.log('=== li-outreach run started', new Date().toISOString(), '===');

  await initSheets();
  await ensureSchema();

  if (FLAGS.init_sheet_only) {
    console.log('init-sheet-only flag set; exiting after schema ensure.');
    return;
  }

  initConnectSafely();
  initClaude();

  // Poll for replies first
  await pollReplies();

  const allLeads = await getAllLeads();
  const allLists = await getAllLists();
  const listById = Object.fromEntries(allLists.map(l => [l.list_id, l]));

  console.log(`[main] ${allLeads.length} total leads, ${allLists.length} lists`);

  let actionsToday = 0;
  let newLeadsToday = 0;
  const now = new Date();

  const shuffled = [...allLeads].sort(() => Math.random() - 0.5);

  for (const lead of shuffled) {
    if (actionsToday >= LIMITS.daily_total_actions) {
      console.log('[main] daily action budget reached, stopping');
      break;
    }

    const plan = decideNextAction(lead, now);
    if (!plan) continue;

    if (plan.action === 'qualify' && newLeadsToday >= LIMITS.daily_new_leads) continue;

    const list = listById[lead.list_id];
    if (!list && plan.action !== 'qualify') {
      console.warn(`[main] lead ${lead.lead_id} has unknown list_id ${lead.list_id}`);
      continue;
    }
    if (list && list.active && String(list.active).toLowerCase() === 'false') continue;

    try {
      await executeAction(lead, list, plan);
      actionsToday++;
      if (plan.action === 'qualify') newLeadsToday++;
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

// Get the profileId for a lead. Prefer the stored linkedin_id;
// fall back to extracting from profile_url.
function leadProfileId(lead) {
  return lead.linkedin_id || extractProfileId(lead.profile_url);
}

async function executeAction(lead, list, plan) {
  console.log(`[exec] ${lead.lead_id} (${lead.name || lead.profile_url}) -> ${plan.action}`);

  if (FLAGS.dry_run) {
    await logAction(lead.lead_id, plan.action, 'success', '[DRY RUN]');
    return;
  }

  switch (plan.action) {
    case 'qualify':           return await actionQualify(lead, list);
    case 'start_sequence':    return await actionStartSequence(lead, list);
    case 'view':              return await actionView(lead, plan);
    case 'follow':            return await actionFollow(lead, plan);
    case 'like':              return await actionLike(lead, list, plan);
    case 'comment':           return await actionComment(lead, list, plan);
    case 'connect':           return await actionConnect(lead, plan);
    case 'check_connection':  return await actionCheckConnection(lead, plan);
    case 'dm':                return await actionDM(lead, list, plan, false);
    case 'follow_up':         return await actionDM(lead, list, plan, true);
    case 'drop':              return await actionDrop(lead, plan.reason);
    default: throw new Error(`unknown action: ${plan.action}`);
  }
}

// ---- Action handlers ----

async function actionQualify(lead, list) {
  lead.status = 'qualifying';
  await updateLead(lead);

  const profileId = extractProfileId(lead.profile_url);
  if (!profileId) throw new Error(`could not extract profileId from URL: ${lead.profile_url}`);

  const profileRes = await fetchProfile(profileId);
  recordRateLimit(profileRes.rateLimit);
  const profile = profileRes.data;

  const postsRes = await fetchProfilePosts(profileId, 10);
  recordRateLimit(postsRes.rateLimit);
  const posts = postsRes.data.posts || postsRes.data || [];

  // Normalize profile fields for Claude
  const profileForClaude = {
    name: [profile.firstName, profile.lastName].filter(Boolean).join(' ') || profile.name,
    headline: profile.headline,
    location: profile.location || profile.geoLocation,
    about: profile.summary || profile.about,
    experience: profile.currentPositions || profile.experience,
  };

  const ctx = await extractContext(profileForClaude, posts);

  if (ctx.skip_reason) {
    lead.status = 'skipped';
    lead.linkedin_id = profileId;
    lead.notes = `Skipped: ${ctx.skip_reason}`;
    await updateLead(lead);
    await logAction(lead.lead_id, 'qualify', 'skipped', ctx.skip_reason);
    return;
  }

  lead.name = profileForClaude.name || lead.name;
  lead.headline = profile.headline || lead.headline;
  lead.linkedin_id = profileId;
  lead.timezone = ctx.inferred_timezone || lead.timezone || 'UTC';
  lead.personalization_context = JSON.stringify(ctx);
  lead.status = 'qualified';
  lead.qualified_at = new Date().toISOString();
  lead.sequence_step = '-1';
  lead.last_action = 'qualify';
  lead.last_action_at = new Date().toISOString();

  await updateLead(lead);
  await logAction(lead.lead_id, 'qualify', 'success', `themes=${ctx.themes?.join('|')}, tz=${ctx.inferred_timezone}`);
}

async function actionStartSequence(lead, list) {
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
  const pid = leadProfileId(lead);
  const res = await visitProfile(pid);
  recordRateLimit(res.rateLimit);
  await advanceLead(lead, plan, 'view');
  await logAction(lead.lead_id, 'view', 'success');
}

async function actionFollow(lead, plan) {
  const pid = leadProfileId(lead);
  const res = await followProfile(pid);
  recordRateLimit(res.rateLimit);
  await advanceLead(lead, plan, 'follow');
  await logAction(lead.lead_id, 'follow', 'success');
}

async function actionLike(lead, list, plan) {
  const pid = leadProfileId(lead);
  const postsRes = await fetchProfilePosts(pid, 5);
  recordRateLimit(postsRes.rateLimit);
  const posts = postsRes.data.posts || postsRes.data || [];
  if (!posts.length) throw new Error('no posts available to like');

  const target = posts[0];
  const postUrn = target.urn || target.postUrn || target.shareUrn || target.id;
  if (!postUrn) throw new Error('post URN not found in response');

  const res = await reactToPost(postUrn, 'LIKE');
  recordRateLimit(res.rateLimit);
  await advanceLead(lead, plan, 'like');
  await logAction(lead.lead_id, 'like', 'success', `post=${postUrn}`);
}

async function actionComment(lead, list, plan) {
  const pid = leadProfileId(lead);
  const postsRes = await fetchProfilePosts(pid, 5);
  recordRateLimit(postsRes.rateLimit);
  const posts = postsRes.data.posts || postsRes.data || [];
  if (!posts.length) throw new Error('no posts available to comment on');

  const target = posts[0];
  const postUrn = target.urn || target.postUrn || target.shareUrn || target.id;
  if (!postUrn) throw new Error('post URN not found');

  const ctx = typeof lead.personalization_context === 'string'
    ? JSON.parse(lead.personalization_context || '{}')
    : (lead.personalization_context || {});
  lead.personalization_context = ctx;

  // Normalize target for Claude
  const targetForClaude = { text: target.content || target.text || target.commentary || '' };

  const commentText = await generateComment(lead, list, targetForClaude);
  const res = await commentOnPost(postUrn, commentText);
  recordRateLimit(res.rateLimit);
  await advanceLead(lead, plan, 'comment');
  await logAction(lead.lead_id, 'comment', 'success', commentText.slice(0, 100));
}

async function actionConnect(lead, plan) {
  const pid = leadProfileId(lead);
  const res = await sendConnectionRequest(pid, null);
  recordRateLimit(res.rateLimit);

  lead.status = 'connecting';
  lead.phase = String(plan.step.phase);
  lead.sequence_step = String(plan.stepIdx);
  lead.last_action = 'connect';
  lead.last_action_at = new Date().toISOString();
  lead.next_action_at = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
  await updateLead(lead);
  await logAction(lead.lead_id, 'connect', 'success');
}

async function actionCheckConnection(lead, plan) {
  const pid = leadProfileId(lead);
  const res = await checkRelationship(pid);
  recordRateLimit(res.rateLimit);
  const degree = (res.data.connectionDegree || res.data.distance || '').toString().toUpperCase();
  const isConnected = degree.includes('DISTANCE_1') || degree === '1' || degree === '1ST';

  if (isConnected) {
    lead.status = 'connected';
    const connectIdx = SEQUENCE.findIndex(s => s.action === 'connect');
    const nextStep = SEQUENCE[connectIdx + 1];
    if (nextStep) {
      const qualifiedAt = new Date(lead.qualified_at);
      lead.next_action_at = computeNextActionAt(qualifiedAt, nextStep, lead).toISOString();
      lead.sequence_step = String(connectIdx);
    }
    await updateLead(lead);
    await logAction(lead.lead_id, 'check_connection', 'success', `accepted, degree=${degree}`);
  } else {
    lead.next_action_at = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    await updateLead(lead);
    await logAction(lead.lead_id, 'check_connection', 'success', `pending, degree=${degree}`);
  }
}

async function actionDM(lead, list, plan, isFollowUp) {
  const pid = leadProfileId(lead);
  const ctx = typeof lead.personalization_context === 'string'
    ? JSON.parse(lead.personalization_context || '{}')
    : (lead.personalization_context || {});
  lead.personalization_context = ctx;

  const text = await generateDM(lead, list, isFollowUp);

  // Simulate human typing speed: 200-300 chars/min ~ 4-5 chars/sec
  const typingMs = Math.min(text.length * 220, 12000);
  const res = await sendMessageWithTyping(pid, text, typingMs);
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

async function advanceLead(lead, plan, actionName) {
  const newStatus = statusAfterAction(actionName);
  if (newStatus) lead.status = newStatus;
  lead.phase = String(plan.step.phase);
  lead.sequence_step = String(plan.stepIdx);
  lead.last_action = actionName;
  lead.last_action_at = new Date().toISOString();

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
    const res = await getRecentMessages(true); // unread only
    recordRateLimit(res.rateLimit);
    const conversations = res.data.conversations || res.data.messages || res.data || [];
    if (!Array.isArray(conversations) || !conversations.length) return;

    const allLeads = await getAllLeads();
    const leadsByProfileId = {};
    allLeads.forEach(l => {
      const pid = leadProfileId(l);
      if (pid) leadsByProfileId[pid.toLowerCase()] = l;
    });

    for (const conv of conversations) {
      const senderId = (conv.senderProfileId || conv.participantProfileId || conv.profileId || '').toLowerCase();
      if (!senderId) continue;
      const lead = leadsByProfileId[senderId];
      if (!lead) continue;
      if (lead.status === 'replied') continue;

      const messageText = conv.lastMessage || conv.message || conv.preview || '';
      lead.status = 'replied';
      lead.response_received = 'true';
      lead.next_action_at = '';
      await updateLead(lead);
      await logConversation(lead.lead_id, 'incoming', 'dm', messageText, true);
      await logAction(lead.lead_id, 'reply_received', 'success', messageText.slice(0, 100));
      console.log(`[poll] REPLY from ${lead.name || lead.profile_url}`);
    }
  } catch (e) {
    console.error('[poll] error:', e.message);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
