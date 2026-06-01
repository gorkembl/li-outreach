// claude.js
// Claude integration for personalization context and DM generation.

import Anthropic from '@anthropic-ai/sdk';
import { CLAUDE, FLAGS } from './config.js';

let client = null;

export function initClaude() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY env var missing');
  client = new Anthropic({ apiKey: key });
  console.log('[claude] initialized');
}

// ----- Extract personalization context from profile + posts -----
export async function extractContext(profile, posts) {
  const sys = `You are analyzing a LinkedIn profile to prepare for highly personalized outreach.
Extract structured signals that will inform later engagement and messaging decisions.
Respond ONLY with valid JSON, no preamble, no markdown code blocks.`;

  const user = `PROFILE:
Name: ${profile.name || 'unknown'}
Headline: ${profile.headline || ''}
Location: ${profile.location || ''}
About: ${(profile.about || '').slice(0, 1500)}
Experience summary: ${JSON.stringify(profile.experience?.slice(0, 3) || [])}

RECENT POSTS (last ${posts.length}):
${posts.map((p, i) => `[${i + 1}] ${((p.content || p.text || p.commentary || '')).slice(0, 400)}`).join('\n\n')}

Return JSON with this shape:
{
  "themes": ["..."],              // 3-5 main topics they engage with
  "tone": "...",                  // their writing tone, e.g. "formal/casual/hot-take/educator"
  "activity_level": "...",        // "very active" | "active" | "occasional" | "dormant"
  "days_since_last_post": 0,
  "skip_reason": null,            // string if we should skip them, null otherwise
  "hook_post_id": null,           // index (1-based) of best post to reference for first engagement
  "hook_post_reason": "...",
  "inferred_timezone": "...",     // e.g. "America/New_York", "Europe/Berlin" — best guess
  "region_category": "...",       // "US" | "EU" | "UK" | "GCC" | "APAC" | "LATAM" | "OTHER"
  "language": "..."               // primary language of their posts, ISO code e.g. "en", "tr", "de"
}

Be honest: if posts are 60+ days old or profile looks dormant, set skip_reason.`;

  const res = await client.messages.create({
    model: CLAUDE.context_model,
    max_tokens: CLAUDE.max_tokens_context,
    system: sys,
    messages: [{ role: 'user', content: user }],
  });

  const text = res.content[0].text.trim();
  // Strip markdown fences if any
  const clean = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(clean);
}

// ----- Generate comment for engagement -----
export async function generateComment(lead, list, targetPost) {
  const sys = `You write LinkedIn comments that sound like a thoughtful peer adding value.
Never salesy. Never compliment-fishing. Add a perspective, a question, or a concrete experience.
Match the post's tone. 1-2 sentences max. No emojis unless the original post used them heavily.`;

  const user = `You are commenting as someone in this role: investment brokerage professional.
The post you're commenting on:
"""
${targetPost.text}
"""

Author context: ${JSON.stringify(lead.personalization_context?.themes || [])}
Tone target: ${list.tone}
Language: ${lead.personalization_context?.language || 'en'}

Write ONE comment. Plain text only, no quotes, no preamble.`;

  const res = await client.messages.create({
    model: CLAUDE.comment_model,
    max_tokens: CLAUDE.max_tokens_comment,
    system: sys,
    messages: [{ role: 'user', content: user }],
  });

  return res.content[0].text.trim();
}

// ----- Generate first DM -----
export async function generateDM(lead, list, isFollowUp = false) {
  const ctx = lead.personalization_context || {};
  const sideLabel = list.target_side === 'investor'
    ? 'an investor (HNW, family office, fund, or accredited)'
    : 'a business owner / founder';

  const sys = `You write LinkedIn DMs for an investment brokerage / advisory firm.
The recipient is ${sideLabel}.
The brokerage is licensed via a partner broker-dealer.

Hard rules:
- 60-90 words for first DM, 40-60 for follow-up.
- Open with a specific, concrete reference to one of their posts or stated interests (never generic).
- Bridge: why you're reaching out, in plain language. No jargon spray.
- Soft ask: a question or an open invitation. No "book a call" links in first message.
- Never name specific securities or deals (regulatory).
- Match their writing tone.
- No exclamation marks. No "Hope this finds you well." No "I came across your profile."
- Sign off with first name only (the sender's name will be appended separately).
- Plain text. No emojis unless their tone clearly uses them.`;

  const gdprNote = FLAGS.gdpr_regions.includes(ctx.region_category)
    ? '\n- Add a brief line at the end like "If outreach like this isn\'t welcome, just let me know and I\'ll leave you be." (GDPR opt-out, in their language)'
    : '';

  const followUpNote = isFollowUp
    ? '\n- This is a FOLLOW-UP after a prior unanswered DM. Acknowledge briefly, add new angle, do not guilt-trip.'
    : '';

  const user = `LIST CONTEXT
List name: ${list.name}
Goal: ${list.goal}
Tone: ${list.tone}
Target side: ${list.target_side}
Service type: ${list.service_type}

LEAD CONTEXT
Name: ${lead.name}
Headline: ${lead.headline}
Themes: ${JSON.stringify(ctx.themes || [])}
Their tone: ${ctx.tone || 'unknown'}
Language: ${ctx.language || 'en'}
Region: ${ctx.region_category || 'unknown'}
Hook post reason: ${ctx.hook_post_reason || 'no specific hook captured'}

Write the DM in ${ctx.language || 'en'}.
${gdprNote}${followUpNote}

Plain text only. Just the DM body.`;

  const res = await client.messages.create({
    model: CLAUDE.dm_model,
    max_tokens: CLAUDE.max_tokens_dm,
    system: sys,
    messages: [{ role: 'user', content: user }],
  });

  return res.content[0].text.trim();
}
