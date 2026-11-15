// spreadTimes(n, {date, from, to}): n posting slots spread across a day, for post_video's `when {date,time}`.
// Dates and times are the accounts' own wall clock: plain calendar dates, no time zones.
// Evenly spaced inside [from, to], rounded to 5 minutes. Posts closer than 30 minutes make a feed look
// automated, so a day holds at most floor((to - from) / 30 min) + 1 posts and the rest spill onto the
// following dates, same window.

const MIN_GAP = 30;
const STEP = 5;

function parseDate(s) {
  const m = typeof s === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
  if (!m) throw new Error(`bad date ${JSON.stringify(s)}: want YYYY-MM-DD`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) {
    throw new Error(`bad date ${JSON.stringify(s)}: no such day`);
  }
  return Date.UTC(y, mo - 1, d);
}

function parseTime(s) {
  const m = typeof s === 'string' ? /^(\d{2}):(\d{2})$/.exec(s) : null;
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`bad time ${JSON.stringify(s)}: want HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}

const pad = (n) => String(n).padStart(2, '0');
const fmtTime = (mins) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);

export function spreadTimes(n, { date, from = '09:00', to = '21:00' } = {}) {
  const day0 = parseDate(date);
  const start = parseTime(from);
  const end = parseTime(to);
  if (end < start) throw new Error(`to ${to} is before from ${from}`);
  if (!Number.isInteger(n)) throw new Error('n must be an integer');
  if (n <= 0) return [];

  const span = end - start;
  const perDay = Math.floor(span / MIN_GAP) + 1;
  const out = [];
  for (let first = 0, day = 0; first < n; first += perDay, day++) {
    const k = Math.min(perDay, n - first);
    const when = fmtDate(day0 + day * 86_400_000);
    for (let i = 0; i < k; i++) {
      const at = k === 1 ? start + span / 2 : start + (i * span) / (k - 1);
      let m = Math.round(at / STEP) * STEP;
      if (m > end) m -= STEP; // a window end that is not on a 5-minute mark must not be overshot
      out.push({ date: when, time: fmtTime(m) });
    }
  }
  return out;
}
