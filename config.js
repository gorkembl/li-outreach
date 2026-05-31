// connectsafely.js
// ConnectSafely API wrapper. Endpoint paths marked TODO are placeholders —
// to be confirmed via their Live Playground (https://connectsafely.ai/docs/api)
// and updated before going live.

const BASE_URL = 'https://api.connectsafely.ai';

let API_KEY = null;

export function initConnectSafely() {
  API_KEY = process.env.CS_API_KEY;
  if (!API_KEY) throw new Error('CS_API_KEY env var missing');
  console.log('[cs] initialized');
}

async function call(method, path, body = null) {
  const headers = {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${BASE_URL}${path}`, opts);

  // Capture rate limit headers
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
    const err = new Error(`CS API ${res.status}: ${data.message || text}`);
    err.status = res.status;
    err.data = data;
    err.rateLimit = rateLimit;
    throw err;
  }

  return { data, rateLimit };
}

// ----- LinkedIn Profiles -----
// TODO: confirm exact path from playground
export async function fetchProfile(profileUrl) {
  return call('POST', '/linkedin/profiles/fetch', { profile_url: profileUrl });
}

// TODO: confirm path
export async function fetchProfilePosts(profileUrl, limit = 10) {
  return call('POST', '/linkedin/posts/by-profile', { profile_url: profileUrl, limit });
}

// ----- LinkedIn Actions -----
// TODO: confirm paths and body schemas via playground

export async function viewProfile(profileUrl) {
  return call('POST', '/linkedin/actions/view-profile', { profile_url: profileUrl });
}

export async function follow(profileUrl) {
  return call('POST', '/linkedin/actions/follow', { profile_url: profileUrl });
}

export async function unfollow(profileUrl) {
  return call('POST', '/linkedin/actions/unfollow', { profile_url: profileUrl });
}

export async function likePost(postUrn) {
  return call('POST', '/linkedin/actions/react', { post_urn: postUrn, reaction: 'LIKE' });
}

export async function commentOnPost(postUrn, text) {
  return call('POST', '/linkedin/actions/comment', { post_urn: postUrn, text });
}

export async function sendConnectionRequest(profileUrl, message = null) {
  const body = { profile_url: profileUrl };
  if (message) body.message = message;
  return call('POST', '/linkedin/actions/connect', body);
}

export async function checkConnectionStatus(profileUrl) {
  return call('POST', '/linkedin/actions/connection-status', { profile_url: profileUrl });
}

export async function sendMessage(profileUrl, text) {
  return call('POST', '/linkedin/messaging/send', { profile_url: profileUrl, text });
}

// ----- Polling for replies -----
export async function getRecentConversations(sinceISO = null) {
  const body = sinceISO ? { since: sinceISO } : {};
  return call('POST', '/linkedin/messaging/conversations', body);
}

// ----- Rate limit helper -----
let lastFollowCheck = { remaining: null, reset: null, checkedAt: null };

export function recordRateLimit(rateLimit) {
  if (rateLimit.action === 'FOLLOW') {
    lastFollowCheck = {
      remaining: parseInt(rateLimit.remaining, 10),
      reset: rateLimit.reset,
      checkedAt: new Date(),
    };
  }
}

export function getFollowRemaining() {
  return lastFollowCheck.remaining;
}
