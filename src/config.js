// config.js
// All tunable parameters. Edit here to adjust system behavior without touching logic.

export const SHEET_TABS = {
  LISTS: 'Lists',
  LEADS: 'Leads',
  ACTION_LOG: 'ActionLog',
  CONVERSATIONS: 'Conversations',
  DASHBOARD: 'Dashboard',
};

// Sheet column schemas. Order matters — these are used to create headers
// and to read/write rows by position.
export const SCHEMAS = {
  Lists: [
    'list_id', 'name', 'target_side', 'service_type',
    'goal', 'tone', 'region', 'active', 'created_at',
  ],
  Leads: [
    'lead_id', 'list_id', 'profile_url', 'linkedin_id', 'name', 'headline',
    'timezone', 'status', 'phase', 'sequence_step', 'qualified_at',
    'personalization_context',
    'last_action', 'last_action_at', 'next_action_at',
    'response_received', 'notes', 'created_at',
  ],
  ActionLog: [
    'timestamp', 'lead_id', 'action', 'result', 'details',
  ],
  Conversations: [
    'timestamp', 'lead_id', 'direction', 'channel', 'message_text', 'needs_review',
  ],
};

// Valid status values. Used for dropdown validation in Sheets.
export const STATUSES = [
  'queued',         // just added, not yet processed
  'qualifying',     // qualification in progress
  'qualified',      // ready to enter sequence
  'skipped',        // failed qualification (inactive, etc)
  'viewing',        // phase 1 active
  'following',      // phase 1 follow done
  'warming',        // phase 2 active (likes, comments)
  'connecting',     // phase 3, connection request sent
  'connected',      // connection accepted
  'dm_sent',        // phase 4 first DM sent
  'follow_up_sent', // follow-up DM sent
  'replied',        // they replied, human takes over
  'dropped',        // no reply, end of sequence
  'error',          // tech error, needs review
  'paused',         // manually paused by user
];

export const TARGET_SIDES = ['investor', 'deal_side'];
export const ACTION_RESULTS = ['success', 'error', 'skipped'];
export const DIRECTIONS = ['incoming', 'outgoing'];
export const CHANNELS = ['dm', 'comment_reply', 'connection_note'];

// Phase definitions. Each step: {day_offset, action, jitter_hours}
// day_offset is days since lead became "qualified"
// jitter_hours = random hours added/subtracted to the scheduled time
export const SEQUENCE = [
  // Phase 1: silent recognition
  { phase: 1, day: 1, action: 'view',    jitter_hours: 4 },
  { phase: 1, day: 3, action: 'follow',  jitter_hours: 4 },

  // Phase 2: passive engagement
  { phase: 2, day: 5, action: 'like',    jitter_hours: 6 },
  { phase: 2, day: 7, action: 'like',    jitter_hours: 6 },
  { phase: 2, day: 9, action: 'comment', jitter_hours: 6 },

  // Phase 3: active engagement
  { phase: 3, day: 12, action: 'comment', jitter_hours: 8 },
  { phase: 3, day: 15, action: 'connect', jitter_hours: 8 },
  { phase: 3, day: 17, action: 'like',    jitter_hours: 12 }, // post-connect settle
  { phase: 3, day: 19, action: 'like',    jitter_hours: 12 }, // continue settle

  // Phase 4: DM
  { phase: 4, day: 21, action: 'dm',         jitter_hours: 8 },
  { phase: 4, day: 28, action: 'follow_up',  jitter_hours: 12 },
];

// Volume and rate limits
export const LIMITS = {
  // Maximum NEW leads to qualify per day (entering sequence)
  daily_new_leads: parseInt(process.env.DAILY_NEW_LEADS || '5', 10),
  // Maximum total actions per day across all leads
  daily_total_actions: parseInt(process.env.DAILY_TOTAL_ACTIONS || '40', 10),
  // ConnectSafely follow limit (their stated limit)
  cs_follow_per_day: 100,
  // Min seconds between any two actions
  min_seconds_between_actions: 240, // 4 minutes
};

// Working hours in lead's local timezone (24h format)
export const WORKING_HOURS = {
  start: 9,   // 09:00
  end: 18,    // 18:00
  // Probability of skipping a weekend day entirely
  weekend_skip_probability: 0.7,
  // Probability of a random weekday "off day"
  weekday_skip_probability: 0.08,
};

// Drop and qualification criteria
export const CRITERIA = {
  // Skip lead if they haven't posted in this many days
  max_days_since_last_post: 60,
  // Days to wait for connection request acceptance before drop
  connection_timeout_days: 7,
  // Days to wait for DM reply before sending follow-up
  dm_followup_wait_days: 7,
  // Days after follow-up to drop if still no reply
  followup_drop_days: 7,
};

// Claude model selection
// Available models (as of June 2026):
//   'claude-opus-4-7'              - most capable, ~5x Sonnet cost
//   'claude-opus-4-6'              - previous gen Opus
//   'claude-sonnet-4-6'            - balanced, recommended default
//   'claude-haiku-4-5-20251001'    - fast and cheap, ~1/4 Sonnet cost
// You can mix and match per task to optimize cost vs quality.
// Use versioned strings (with date suffix) in production, not aliases.
export const CLAUDE = {
  // Profile analysis -> structured JSON. Haiku is sufficient here.
  context_model: 'claude-haiku-4-5-20251001',
  // Peer-style comments on posts. Needs nuance, Sonnet recommended.
  comment_model: 'claude-sonnet-4-6',
  // First DMs and follow-ups. Highest stakes, Sonnet or Opus.
  dm_model: 'claude-sonnet-4-6',

  // Token budgets
  max_tokens_context: 1500,
  max_tokens_dm: 400,
  max_tokens_comment: 200,
};

// Behavior toggles
export const FLAGS = {
  dry_run: process.env.DRY_RUN === 'true',
  init_sheet_only: process.argv.includes('--init-sheet-only'),
  // EU/UK/UK regions get opt-out line appended to first DM (GDPR)
  gdpr_regions: ['EU', 'UK', 'EEA'],
};
