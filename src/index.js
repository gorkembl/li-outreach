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

// In dry_run, sleep this long between actions (in ms). Normal mode uses LIMITS.
const DRY_RUN_SLEEP_MS = 5_000;

async function main() {
  console.log('=== li-outreach run started', new Date().toISOString(), '===');
  if (FLAGS.dry_run) console.log('*** DRY RUN MODE — no LinkedIn side effects will occur ***');

  await initSheets();
  await ensureSchema();

  if (FLAGS.init_sheet_only) {
    console.log('init-sheet-only flag set; exiting after schema ensure.');
    return;
  }

  initConnectSafely();
  initClaude();

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

    console.log(`[scan] lead=${lead.lead_id} status="${lead.status}" list_id="${lead.list_id}" next_action_at="${lead.next_action_at}"`);

    const plan = decideNextAction(lead, now);
    if (!plan) {
      console.log(`[scan]   -> no action needed (decideNextAction returned null)`);
      continue;
    }
    console.log(`[scan]   -> plan: ${plan.action}`);

    if (plan.action === 'qualify' && newLeadsToday >= LIMITS.daily_new_leads) {
      console.log(`[scan]   -> skipped: daily new lead cap reached`);
      continue;
    }

    const list = listById[lead.list_id];
    if (!list && plan.action !== 'qualify') {
      console.warn(`[scan]   -> skipped: unknown list_id "${lead.list_id}". Known lists: ${Object.keys(listById).join(', ')}`);
      continue;
    }
    if (list && list.active && String(list.active).toLowerCase() === 'false') {
      console.log(`[scan]   -> skipped: list ${list.list_id} is inactive (active="${list.active}")`);
      continue;
    }

    try {
      await executeAction(lead, list, plan);
      actionsToday++;
      if (plan.action === 'qualify') newLeadsToday++;
      const sleepMs = FLAGS.dry_run
        ? DRY_RUN_SLEEP_MS
        : (LIMITS.min_seconds_between_actions * 1000 + Math.random() * 60_000);
      await sleep(sleepMs);
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

function leadProfileId(lead) {
  return lead.linkedin_id || extractProfileId(lead.profile_url);
}

async function executeAction(lead, list, plan) {
  console.log(`[exec] ${lead.lead_id} (${lead.name || lead.profile_url}) -> ${plan.action}`);

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
// Read-only actions (qualify, check_connection) always run, even in dry_run.
// Side-effect actions skip the actual ConnectSafely call when dry_run=true
// but still generate content (DM, comment) via Claude so output can be inspected.

async function actionQualify(lead, list) {
  // Always runs — no LinkedIn side effect (just data reads).
  lead.status = 'qualifying';
  await updateLead(lead);

  const profileId = extractProfileId(lead.profile_url);
  if (!profileId) throw new Error(`could not extract profileId from URL: ${lead.profile_url}`);

  console.log(`[qualify] fetching profile: ${profileId}`);
  const profileRes = await fetchProfile(profileId);
  recordRateLimit(profileRes.rateLimit);
  const profile = profileRes.data;
  console.log(`[qualify] raw profile response keys: ${Object.keys(profile || {}).join(', ')}`);
  console.log(`[qualify] raw profile (first 1500 chars):\n${JSON.stringify(profile).slice(0, 1500)}`);

  console.log(`[qualify] fetching posts: ${profileId}`);
  const postsRes = await fetchProfilePosts(profileId, 10);
  recordRateLimit(postsRes.rateLimit);
  const postsRaw = postsRes.data;
  console.log(`[qualify] raw posts response keys: ${Object.keys(postsRaw || {}).join(', ')}`);
  console.log(`[qualify] raw posts (first 1500 chars):\n${JSON.stringify(postsRaw).slice(0, 1500)}`);
  const posts = postsRaw.posts || postsRaw.data || (Array.isArray(postsRaw) ? postsRaw : []);
  console.log(`[qualify] parsed ${Array.isArray(posts) ? posts.length : 0} posts`);

  // ConnectSafely wraps profile data in a nested `profile` object.
  // Field names: aboutText (not about), experience array with {title, companyName, duration, location}
  const p = profile.profile || profile; // fallback if response shape changes
  const profileForClaude = {
    name: [p.firstName, p.lastName].filter(Boolean).join(' ') || p.name || '',
    headline: p.headline || '',
    location: p.location?.geoLocationName || p.location?.name || p.location || '',
    about: p.aboutText || p.summary || p.about || '',
    experience: p.experience || p.currentPositions || [],
    followerCount: p.followerCount,
    isPremium: p.isPremium,
  };
  console.log(`[qualify] profileForClaude: ${JSON.stringify(profileForClaude).slice(0, 800)}`);

  console.log(`[qualify] calling Claude for context extraction`);
  const ctx = await extractContext(profileForClaude, posts);
  console.log(`[qualify] claude result: themes=${JSON.stringify(ctx.themes)} skip=${ctx.skip_reason || 'no'} lang=${ctx.language} region=${ctx.region_category}`);

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
  if (FLAGS.dry_run) {
    console.log(`[DRY] would visit profile ${pid}`);
    await logAction(lead.lead_id, 'view', 'success', '[DRY RUN]');
  } else {
    const res = await visitProfile(pid);
    recordRateLimit(res.rateLimit);
    await logAction(lead.lead_id, 'view', 'success');
  }
  await advanceLead(lead, plan, 'view');
}

async function actionFollow(lead, plan) {
  const pid = leadProfileId(lead);
  if (FLAGS.dry_run) {
    console.log(`[DRY] would follow ${pid}`);
    await logAction(lead.lead_id, 'follow', 'success', '[DRY RUN]');
  } else {
    const res = await followProfile(pid);
    recordRateLimit(res.rateLimit);
    await logAction(lead.lead_id, 'follow', 'success');
  }
  await advanceLead(lead, plan, 'follow');
}

async function actionLike(lead, list, plan) {
  const pid = leadProfileId(lead);
  const postsRes = await fetchProfilePosts(pid, 5);
  recordRateLimit(postsRes.rateLimit);
  const posts = postsRes.data.posts || postsRes.data || [];
  if (!posts.length) throw new Error('no posts available to like');

  const target = posts[0];
  const postUrn = target.activityUrn || target.urn || target.postUrn || target.shareUrn || target.id;
  if (!postUrn) throw new Error('post URN not found in response');

  if (FLAGS.dry_run) {
    console.log(`[DRY] would LIKE post ${postUrn}`);
    await logAction(lead.lead_id, 'like', 'success', `[DRY RUN] post=${postUrn}`);
  } else {
    const res = await reactToPost(postUrn, 'LIKE');
    recordRateLimit(res.rateLimit);
    await logAction(lead.lead_id, 'like', 'success', `post=${postUrn}`);
  }
  await advanceLead(lead, plan, 'like');
}

async function actionComment(lead, list, plan) {
  const pid = leadProfileId(lead);
  const postsRes = await fetchProfilePosts(pid, 5);
  recordRateLimit(postsRes.rateLimit);
  const posts = postsRes.data.posts || postsRes.data || [];
  if (!posts.length) throw new Error('no posts available to comment on');

  const target = posts[0];
  const postUrn = target.activityUrn || target.urn || target.postUrn || target.shareUrn || target.id;
  if (!postUrn) throw new Error('post URN not found');

  const ctx = typeof lead.personalization_context === 'string'
    ? JSON.parse(lead.personalization_context || '{}')
    : (lead.personalization_context || {});
  lead.personalization_context = ctx;

  const targetForClaude = { text: target.content || target.text || target.commentary || '' };
  const commentText = await generateComment(lead, list, targetForClaude);
  console.log(`[comment] generated: ${commentText}`);

  if (FLAGS.dry_run) {
    console.log(`[DRY] would COMMENT on post ${postUrn}: "${commentText}"`);
    await logAction(lead.lead_id, 'comment', 'success', `[DRY RUN] ${commentText.slice(0, 100)}`);
  } else {
    const res = await commentOnPost(postUrn, commentText);
    recordRateLimit(res.rateLimit);
    await logAction(lead.lead_id, 'comment', 'success', commentText.slice(0, 100));
  }
  await advanceLead(lead, plan, 'comment');
}

async function actionConnect(lead, plan) {
  const pid = leadProfileId(lead);
  if (FLAGS.dry_run) {
    console.log(`[DRY] would send connection request to ${pid}`);
    await logAction(lead.lead_id, 'connect', 'success', '[DRY RUN]');
  } else {
    const res = await sendConnectionRequest(pid, null);
    recordRateLimit(res.rateLimit);
    await logAction(lead.lead_id, 'connect', 'success');
  }
  lead.status = 'connecting';
  lead.phase = String(plan.step.phase);
  lead.sequence_step = String(plan.stepIdx);
  lead.last_action = 'connect';
  lead.last_action_at = new Date().toISOString();
  lead.next_action_at = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
  await updateLead(lead);
}

async function actionCheckConnection(lead, plan) {
  const pid = leadProfileId(lead);
  // Always runs — no LinkedIn side effect (just reads relationship status)
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
  console.log(`[dm] generated (${text.length} chars):\n---\n${text}\n---`);

  const typingMs = Math.min(text.length * 220, 12000);

  if (FLAGS.dry_run) {
    console.log(`[DRY] would send DM to ${pid} (${text.length} chars, ~${typingMs}ms typing)`);
    await logAction(lead.lead_id, isFollowUp ? 'follow_up' : 'dm', 'success', `[DRY RUN] chars=${text.length}`);
  } else {
    const res = await sendMessageWithTyping(pid, text, typingMs);
    recordRateLimit(res.rateLimit);
    await logAction(lead.lead_id, isFollowUp ? 'follow_up' : 'dm', 'success', `chars=${text.length}`);
  }
  await logConversation(lead.lead_id, 'outgoing', 'dm', text, false);
  await advanceLead(lead, plan, isFollowUp ? 'follow_up' : 'dm');
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

async function pollReplies() {
  try {
    const res = await getRecentMessages(true);
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
