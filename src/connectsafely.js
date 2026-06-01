// connectsafely.js
// ConnectSafely API wrapper. All endpoints confirmed from official docs
// at https://connectsafely.ai/docs/api as of 2026-05.

const BASE_URL = 'https://api.connectsafely.ai';

let API_KEY = null;

export function initConnectSafely() {
  API_KEY = process.env.CS_API_KEY;
  if (!API_KEY) throw new Error('CS_API_KEY env var missing');
  console.log('[cs] initialized');
}

// Extract LinkedIn profileId from a profile URL.
// "https://www.linkedin.com/in/john-doe-123/" -> "john-doe-123"
export function extractProfileId(profileUrl) {
  if (!profileUrl) return null;
  const m = profileUrl.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

async function call(method, path, body = null, query = null) {
  let url = `${BASE_URL}${path}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    url += `?${qs}`;
  }
  const headers = {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  };
  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);

  const rateLimit = {
    action: res.headers.get('X-RateLimit-Action'),
    limit: res.headers.get('X-RateLimit-Limit'),
    used: res.headers.get('X-RateLimit-Used'),
    remaining: res.headers.get('X-RateLimit-Remaining'),
    reset: res.headers.get('X-RateLimit-Reset'),
  };

  let data;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    const err = new Error(`CS API ${res.status} ${path}: ${data.message || data.error || text}`);
    err.status = res.status;
    err.data = data;
    err.rateLimit = rateLimit;
    throw err;
  }

  return { data, rateLimit };
}

// =====================================================================
// LinkedIn Profiles
// =====================================================================

// Fetch profile by profileId (e.g. "john-doe-123")
// Returns: firstName, lastName, headline, summary, location, currentPositions, etc.
// Rate limit: 120 unique profiles per day (cached for 6h)
export async function fetchProfile(profileId) {
  return call('POST', '/linkedin/profile', { profileId });
}

// Visit a profile (registers as a profile view in LinkedIn)
// This is what we use for Phase 1 "view" action
export async function visitProfile(profileId) {
  return call('POST', '/linkedin/profile/visit', { profileId });
}

// =====================================================================
// LinkedIn Posts
// =====================================================================

// Get latest posts from a profile
// API parameter is `count` (not `limit`). Max 20.
// Returns array of posts with URN, content, engagement, timestamps
export async function fetchProfilePosts(profileId, count = 20, includeReposts = false) {
  return call('POST', '/linkedin/posts/latest', {
    profileId,
    count,
    includeReposts,
  });
}

// React to a post
// reaction options: LIKE, PRAISE, APPRECIATION, EMPATHY, INTEREST, ENTERTAINMENT
export async function reactToPost(postUrn, reaction = 'LIKE') {
  return call('POST', '/linkedin/posts/react', { postUrn, reaction });
}

// Comment on a post
export async function commentOnPost(postUrn, text) {
  return call('POST', '/linkedin/posts/comment', { postUrn, text });
}

// =====================================================================
// LinkedIn Actions (follow, connect, message, relationship)
// =====================================================================

// Follow a profile (or unfollow with action: "unfollow")
// Rate limit: 100 actions per day
export async function followProfile(profileId) {
  return call('POST', '/linkedin/follow', { profileId, action: 'follow' });
}

export async function unfollowProfile(profileId) {
  return call('POST', '/linkedin/follow', { profileId, action: 'unfollow' });
}

// Send connection request (300 char limit on message; null = no note)
export async function sendConnectionRequest(profileId, message = null) {
  const body = { profileId };
  if (message) body.message = message.slice(0, 300);
  return call('POST', '/linkedin/connect', body);
}

// Check relationship status with a profile
// Returns: connectionDegree (DISTANCE_1, DISTANCE_2, DISTANCE_3, etc), follow status
export async function checkRelationship(profileId) {
  return call('GET', `/linkedin/relationship/${encodeURIComponent(profileId)}`);
}

// Direct message (basic, requires 1st-degree connection)
export async function sendMessage(recipientProfileId, message) {
  return call('POST', '/linkedin/message', { recipientProfileId, message });
}

// Direct message with typing indicator (recommended for human-like behavior)
export async function sendMessageWithTyping(recipientProfileId, message, typingDurationMs = null) {
  const body = { recipientProfileId, message };
  if (typingDurationMs) body.typingDurationMs = typingDurationMs;
  return call('POST', '/linkedin/messaging/send-with-typing', body);
}

// =====================================================================
// LinkedIn Messaging (polling for replies)
// =====================================================================

// Get recent messages/conversations
// Used for polling: detect when leads reply
// Rate limit: 150 messages per day per account
export async function getRecentMessages(unreadOnly = false) {
  const query = {};
  if (unreadOnly) query.unreadOnly = 'true';
  return call('GET', '/linkedin/messaging/recent-messages', null, query);
}

// =====================================================================
// Rate limit tracking
// =====================================================================

const rateLimitState = {
  FOLLOW: { remaining: null, reset: null, checkedAt: null },
  PROFILE: { remaining: null, reset: null, checkedAt: null },
  MESSAGE: { remaining: null, reset: null, checkedAt: null },
};

export function recordRateLimit(rateLimit) {
  if (!rateLimit || !rateLimit.action) return;
  const key = rateLimit.action.toUpperCase();
  if (rateLimitState[key]) {
    rateLimitState[key] = {
      remaining: rateLimit.remaining ? parseInt(rateLimit.remaining, 10) : null,
      reset: rateLimit.reset,
      checkedAt: new Date(),
    };
  }
}

export function getRateLimitState(action) {
  return rateLimitState[action.toUpperCase()] || null;
}
