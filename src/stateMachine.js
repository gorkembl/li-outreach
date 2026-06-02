// stateMachine.js
// Core decision logic. Given a lead's state, determines next action.

import { SEQUENCE, CRITERIA, WORKING_HOURS, LIMITS, FLAGS } from './config.js';

// Returns an action plan for a lead, or null if nothing to do right now.
// Possible returns:
//   { action: 'qualify' }
//   { action: 'start_sequence' }  -- first scheduling after qualification
//   { action: 'view'|'follow'|'like'|'comment'|'connect'|'dm'|'follow_up', step }
//   { action: 'check_connection' }
//   { action: 'drop', reason }
//   null  (skip this run)
export function decideNextAction(lead, now = new Date()) {
  const status = lead.status || 'queued';

  // Terminal states — nothing to do
  if (['replied', 'dropped', 'skipped', 'error', 'paused'].includes(status)) {
    return null;
  }

  // Queued — needs qualification
  if (status === 'queued') {
    return { action: 'qualify' };
  }

  // Just qualified — schedule first step
  if (status === 'qualified') {
    return { action: 'start_sequence' };
  }

  // Connecting — check if connection accepted
  if (status === 'connecting') {
    const qualifiedAt = parseDate(lead.qualified_at);
    if (!qualifiedAt) return null;
    const connectStep = SEQUENCE.find(s => s.action === 'connect');
    const connectDay = connectStep?.day || 15;
    const daysSinceConnect = daysBetween(addDays(qualifiedAt, connectDay), now);
    if (daysSinceConnect >= CRITERIA.connection_timeout_days) {
      return { action: 'drop', reason: 'connection_not_accepted' };
    }
    // Check status if next_action_at has passed
    if (isDue(lead.next_action_at, now)) {
      return { action: 'check_connection' };
    }
    return null;
  }

  // Active states — check if due for next step
  if (['viewing', 'following', 'warming', 'connected', 'dm_sent', 'follow_up_sent'].includes(status)) {
    if (!isDue(lead.next_action_at, now)) return null;
    if (!FLAGS.debug_fast_sequence && !isWithinWorkingHours(now, lead.timezone)) return null;

    const stepIdx = parseInt(lead.sequence_step, 10);
    const nextIdx = isNaN(stepIdx) ? 0 : stepIdx + 1;

    if (nextIdx >= SEQUENCE.length) {
      // Reached end of sequence
      if (status === 'dm_sent' || status === 'follow_up_sent') {
        const lastActionAt = parseDate(lead.last_action_at);
        const dropAfter = status === 'follow_up_sent'
          ? CRITERIA.followup_drop_days
          : CRITERIA.dm_followup_wait_days + CRITERIA.followup_drop_days;
        if (lastActionAt && daysBetween(lastActionAt, now) >= dropAfter) {
          return { action: 'drop', reason: 'no_reply' };
        }
      }
      return null;
    }

    const step = SEQUENCE[nextIdx];
    return { action: step.action, step, stepIdx: nextIdx };
  }

  return null;
}

// ----- Working hours and timezone helpers -----
export function isWithinWorkingHours(now, timezone) {
  if (!timezone) timezone = 'UTC';
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
      weekday: 'short',
    });
    const parts = fmt.formatToParts(now);
    const hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const weekday = parts.find(p => p.type === 'weekday').value;

    const isWeekend = weekday === 'Sat' || weekday === 'Sun';
    if (isWeekend && Math.random() < WORKING_HOURS.weekend_skip_probability) return false;
    if (!isWeekend && Math.random() < WORKING_HOURS.weekday_skip_probability) return false;

    return hour >= WORKING_HOURS.start && hour < WORKING_HOURS.end;
  } catch (e) {
    // Invalid timezone, fall back to UTC working hours
    const hour = now.getUTCHours();
    return hour >= WORKING_HOURS.start && hour < WORKING_HOURS.end;
  }
}

// Compute the next_action_at for a given sequence step, based on qualifiedAt.
export function computeNextActionAt(qualifiedAt, step, lead) {
  const base = addDays(qualifiedAt, step.day);
  // Random hours of jitter (+/-)
  const jitterMs = (Math.random() * 2 - 1) * step.jitter_hours * 3600 * 1000;
  const target = new Date(base.getTime() + jitterMs);

  // Snap to working hours in lead's timezone
  return snapToWorkingHours(target, lead.timezone || 'UTC');
}

function snapToWorkingHours(date, timezone) {
  // If target time is outside working hours, push to next working window
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    });
    const hour = parseInt(fmt.formatToParts(date).find(p => p.type === 'hour').value, 10);

    if (hour < WORKING_HOURS.start) {
      // Push forward to start of working hours same day
      const diff = WORKING_HOURS.start - hour + Math.random() * 3; // a bit of variance
      return new Date(date.getTime() + diff * 3600 * 1000);
    }
    if (hour >= WORKING_HOURS.end) {
      // Push to next morning
      const hoursToNext = (24 - hour) + WORKING_HOURS.start + Math.random() * 2;
      return new Date(date.getTime() + hoursToNext * 3600 * 1000);
    }
    return date;
  } catch {
    return date;
  }
}

// ----- Date utilities -----
function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function isDue(nextActionAt, now) {
  const target = parseDate(nextActionAt);
  if (!target) return true; // no time set = treat as due
  return now >= target;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 3600 * 1000);
}

function daysBetween(a, b) {
  return Math.floor((b.getTime() - a.getTime()) / (24 * 3600 * 1000));
}

// ----- Status transitions for each action -----
// Returns the new status after executing a given action successfully.
export function statusAfterAction(action) {
  const map = {
    qualify: 'qualified',
    view: 'viewing',
    follow: 'following',
    like: 'warming',
    comment: 'warming',
    connect: 'connecting',
    check_connection: null, // depends on result
    dm: 'dm_sent',
    follow_up: 'follow_up_sent',
  };
  return map[action];
}
