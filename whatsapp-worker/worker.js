// Lift.Log WhatsApp Worker (Cloudflare)
//
// Routes:
//   GET  /                        → health check
//   GET  /events?from=whatsapp:+27...   → list events for that user (JSON)
//   POST /sms                     → Twilio webhook for inbound WhatsApp messages
//
// Required environment variables (Worker secrets):
//   TWILIO_ACCOUNT_SID     e.g. AC...
//   TWILIO_AUTH_TOKEN      the Twilio auth token
//
// Required bindings:
//   EVENTS                 KV namespace (created via API or dashboard)

const TWILIO_FROM = 'whatsapp:+14155238886';

// South Africa is UTC+2 year-round (no DST). Adjust if user moves.
const TZ_OFFSET_HOURS = 2;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('lift.log whatsapp worker — ok', { status: 200 });
    }

    if (url.pathname === '/events' && request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders('GET, POST, DELETE, OPTIONS') });
    }
    if (url.pathname === '/events' && request.method === 'GET') {
      return handleEventsGet(request, env);
    }
    if (url.pathname === '/events' && request.method === 'POST') {
      return handleEventsPost(request, env);
    }
    if (url.pathname === '/events' && request.method === 'DELETE') {
      return handleEventsDelete(request, env);
    }

    if (url.pathname === '/welcome' && request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders('POST, OPTIONS') });
    }
    if (url.pathname === '/welcome' && request.method === 'POST') {
      return handleWelcome(request, env);
    }

    if (url.pathname === '/sms' && request.method === 'POST') {
      return handleInbound(request, env);
    }

    return new Response('not found', { status: 404 });
  }
};

function corsHeaders(methods) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': methods || 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store'
  };
}

async function handleEventsGet(request, env) {
  const url = new URL(request.url);
  const from = url.searchParams.get('from') || '';
  if (!from) {
    return new Response(JSON.stringify({ error: 'missing from' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }

  if (!env.EVENTS) {
    return new Response(JSON.stringify({ events: [], note: 'EVENTS KV binding not configured' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() }
    });
  }

  const prefix = `evt:${from}:`;
  const list = await env.EVENTS.list({ prefix, limit: 1000 });
  const events = [];
  for (const key of list.keys) {
    try {
      const val = await env.EVENTS.get(key.name);
      if (val) events.push(JSON.parse(val));
    } catch (_) { /* skip malformed */ }
  }

  // Sort newest-first
  events.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));

  return new Response(JSON.stringify({ events }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

// POST /events — write an in-app event into KV.
// Body JSON: { from, type, activity, durationMin?, date? }
// `from` must be `whatsapp:+<digits>`; date defaults to today if omitted.
async function handleEventsPost(request, env) {
  if (!env.EVENTS) {
    return new Response(JSON.stringify({ error: 'EVENTS KV binding not configured' }), {
      status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders('GET, POST, OPTIONS') }
    });
  }
  let body;
  try { body = await request.json(); }
  catch { return jsonErr('bad json', 400); }

  const from = String(body && body.from || '').trim();
  if (!/^whatsapp:\+\d{6,20}$/.test(from)) return jsonErr('invalid from', 400);

  const type = body.type === 'bio' ? 'bio' : 'activity';
  const activity = String(body.activity || '').slice(0, 100).trim();
  if (!activity) return jsonErr('missing activity', 400);

  let durationMin = null;
  if (body.durationMin !== null && body.durationMin !== undefined) {
    const d = parseInt(body.durationMin, 10);
    if (Number.isFinite(d) && d >= 0 && d <= 24 * 60) durationMin = d;
  }

  let date = String(body.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = localToday();

  // Reuse the client's id if it sent one (so app + server stay in sync), else mint a new one.
  const rawId = String(body.id || '').slice(0, 64);
  const id = /^[A-Za-z0-9_-]+$/.test(rawId) ? rawId : newId();
  const stored = { type, activity, durationMin, date, from, ts: new Date().toISOString(), id, raw: '(in-app)' };

  try {
    await env.EVENTS.put(`evt:${from}:${date}:${id}`, JSON.stringify(stored));
  } catch (err) {
    return jsonErr('kv put failed: ' + (err && err.message), 500);
  }
  return new Response(JSON.stringify({ ok: true, event: stored }), {
    status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders('GET, POST, OPTIONS') }
  });
}

// DELETE /events?from=whatsapp:+...&date=YYYY-MM-DD&id=<event-id>
async function handleEventsDelete(request, env) {
  if (!env.EVENTS) return jsonErr('EVENTS KV binding not configured', 503);
  const url = new URL(request.url);
  const from = url.searchParams.get('from') || '';
  const date = url.searchParams.get('date') || '';
  const id = url.searchParams.get('id') || '';
  if (!/^whatsapp:\+\d{6,20}$/.test(from)) return jsonErr('invalid from', 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonErr('invalid date', 400);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return jsonErr('invalid id', 400);

  const key = `evt:${from}:${date}:${id}`;
  try {
    await env.EVENTS.delete(key);
  } catch (err) {
    return jsonErr('kv delete failed: ' + (err && err.message), 500);
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders('GET, POST, DELETE, OPTIONS') }
  });
}

// POST /welcome — send a welcome WhatsApp message listing trigger phrases.
// Body JSON: { to: "whatsapp:+27..." }
async function handleWelcome(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonErr('bad json', 400); }

  const to = String(body && body.to || '').trim();
  if (!/^whatsapp:\+\d{6,20}$/.test(to)) return jsonErr('invalid to', 400);

  const msg = [
    'Welcome to Lift.Log 👋',
    '',
    'Message me what you did and I\'ll add a blue dot to your calendar.',
    '',
    'Trigger phrases:',
    '🌊 1h swim · 40min swim',
    '🚴 2h cycle · 30min cycle',
    '🥾 1h hike · 2h hike',
    '🌀 1h spinning · 1h spinning class',
    '🏖️ 1h beach bats',
    '🏃 1h run · 🚶 30min walk',
    '🧘 1h yoga · 🤸 20min stretch',
    '💪 legs bio session done · upper body bio',
    '',
    'Backdate by starting with a date:',
    '"yesterday 1h swim"',
    '"monday 30min cycle"',
    '"15 may 1h hike"'
  ].join('\n');

  try {
    await sendTwilio(env, to, msg);
  } catch (err) {
    return jsonErr('twilio send failed: ' + (err && err.message), 500);
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders('POST, OPTIONS') }
  });
}

function jsonErr(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { 'Content-Type': 'application/json', ...corsHeaders('GET, POST, OPTIONS') }
  });
}

async function handleInbound(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch (err) {
    console.error('formData parse failed:', err && err.message);
    return new Response('bad request', { status: 400 });
  }

  const body = (form.get('Body') || '').trim();
  const from = form.get('From') || '';

  console.log('inbound:', JSON.stringify({
    from, body,
    sidPresent: !!env.TWILIO_ACCOUNT_SID,
    tokenPresent: !!env.TWILIO_AUTH_TOKEN,
    eventsBinding: !!env.EVENTS
  }));

  const { reply, event } = parseMessage(body);

  // Persist the event (if any) before replying — best-effort.
  if (event && env.EVENTS) {
    try {
      const dateKey = event.date || localToday();
      const id = newId();
      const stored = { ...event, date: dateKey, from, ts: new Date().toISOString(), id };
      await env.EVENTS.put(`evt:${from}:${dateKey}:${id}`, JSON.stringify(stored));
      console.log('stored event:', id);
    } catch (err) {
      console.error('KV put failed:', err && err.message);
    }
  }

  try {
    await sendTwilio(env, from, reply);
  } catch (err) {
    console.error('sendTwilio failed:', err && err.message, err && err.stack);
    return new Response('twilio send failed: ' + (err && err.message), { status: 500 });
  }

  return new Response('', { status: 200 });
}

function localDateString(offsetDays) {
  const ms = Date.now() + TZ_OFFSET_HOURS * 60 * 60 * 1000 - (offsetDays || 0) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function localToday() { return localDateString(0); }

// Parse an optional "date prefix" at the start of `body`, return { dateKey, rest }
// where dateKey is YYYY-MM-DD (or null if no date prefix was found) and `rest`
// is the body with the date stripped. Examples it recognises:
//   "yesterday 1h swim"     -> { dateKey: yesterday,  rest: "1h swim" }
//   "today 1h swim"         -> { dateKey: today,      rest: "1h swim" }
//   "monday 1h hike"        -> { dateKey: most recent past Monday, rest: "1h hike" }
//   "15 may 1h cycle"       -> { dateKey: 2026-05-15, rest: "1h cycle" }
//   "may 15 1h cycle"       -> same
//   "15/5 1h cycle"         -> 2026-05-15
//   "2026-05-15 1h cycle"   -> 2026-05-15
function parseDatePrefix(body) {
  const lower = body.toLowerCase().trim();
  if (!lower) return { dateKey: null, rest: body };

  // Yesterday / today
  let m = lower.match(/^(yesterday|today)\b[\s,:-]*(.*)$/);
  if (m) {
    return { dateKey: m[1] === 'yesterday' ? localDateString(1) : localToday(), rest: m[2] };
  }

  // Weekday names — most recent past day with that weekday
  const WD = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
  m = lower.match(/^([a-z]+)\b[\s,:-]*(.*)$/);
  if (m && WD.hasOwnProperty(m[1])) {
    const target = WD[m[1]];
    const today = new Date(localToday() + 'T00:00:00Z');
    const todayWd = today.getUTCDay();
    let diff = (todayWd - target + 7) % 7;
    if (diff === 0) diff = 7; // same weekday → previous week (so "monday" said on Monday means last Monday)
    return { dateKey: localDateString(diff), rest: m[2] };
  }

  // ISO yyyy-mm-dd
  m = lower.match(/^(\d{4})-(\d{2})-(\d{2})\b[\s,:-]*(.*)$/);
  if (m) {
    return { dateKey: `${m[1]}-${m[2]}-${m[3]}`, rest: m[4] };
  }

  // DD/MM or DD-MM (no year → current year)
  m = lower.match(/^(\d{1,2})[\/\-](\d{1,2})\b[\s,:-]*(.*)$/);
  if (m) {
    const d = parseInt(m[1], 10), mo = parseInt(m[2], 10);
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
      const y = parseInt(localToday().slice(0, 4), 10);
      return { dateKey: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, rest: m[3] };
    }
  }

  // DD MMM  /  MMM DD
  const MONTHS = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
  // "15 may"
  m = lower.match(/^(\d{1,2})\s+([a-z]+)\b[\s,:-]*(.*)$/);
  if (m && MONTHS[m[2]]) {
    const d = parseInt(m[1], 10), mo = MONTHS[m[2]];
    const y = parseInt(localToday().slice(0, 4), 10);
    return { dateKey: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, rest: m[3] };
  }
  // "may 15"
  m = lower.match(/^([a-z]+)\s+(\d{1,2})\b[\s,:-]*(.*)$/);
  if (m && MONTHS[m[1]]) {
    const d = parseInt(m[2], 10), mo = MONTHS[m[1]];
    const y = parseInt(localToday().slice(0, 4), 10);
    return { dateKey: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, rest: m[3] };
  }

  return { dateKey: null, rest: body };
}

// ---------- Parser ----------

export function parseMessage(body) {
  const raw = (body || '').trim();
  if (!raw) return { reply: 'Got an empty message.', event: null };

  // Greetings (before date prefix so "hi" doesn't trip the weekday parser)
  if (/^(hi|hello|hey|sup|yo|howzit)\b/i.test(raw)) {
    return {
      reply: 'Hey 👋 Try: "1h swim", "yesterday 1h hike", "monday 30min cycle", "1h30 hike", "lower body bio done".',
      event: null
    };
  }

  // Optional date prefix — strip it and remember the dateKey it parsed to.
  const datePrefix = parseDatePrefix(raw);
  const dateKey = datePrefix.dateKey;
  const lower = (datePrefix.rest || raw).toLowerCase().trim();
  if (!lower) {
    return { reply: 'Got a date but no activity. Try: "yesterday 1h swim".', event: null };
  }

  // Strip optional polite prefix so the rest can be parsed uniformly
  const stripped = lower.replace(/^(did|done|completed|finished|just|just\s+did|had)\s+(a\s+)?/i, '').trim();

  // ---- Bio session ----
  // "legs bio session done", "back bio", "bio session done", "chest bio session completed",
  // "lower body bio", "upper body bio done"
  const bioM = stripped.match(
    /^(?:(lower body|upper body|legs?|chest|back|arms?|shoulders?|core|full[- ]?body)\s+)?bio(?:kinetics)?(?:\s+session)?(?:\s+done|\s+completed|\s+finished)?\s*$/
  );
  if (bioM) {
    let part = (bioM[1] || '').replace(/\s+/g, ' ').trim();
    if (part === 'legs' || part === 'leg') part = 'lower body';
    if (part === 'chest') part = 'upper body';
    if (part === 'full-body' || part === 'fullbody') part = 'full body';
    const activity = part ? `${part} bio session` : 'bio session';
    const suffix = dateKey ? ` · ${prettyDate(dateKey)}` : '';
    return {
      reply: `logged ✓ ${activity}${suffix}`,
      event: { type: 'bio', activity, bodyPart: part || null, durationMin: null, raw: body.trim(), date: dateKey }
    };
  }

  // ---- Activity with duration ----
  const ACTIVITY = '(swim|swimming|cycle|cycling|ride|riding|bike|biking|hike|hiking|walk|walking|run|running|jog|jogging|spinning(?:\\s+class)?|spin|yoga|stretch|stretching|workout|beach\\s*bats|matkot|padel|paddle\\s*ball)';

  // "1h30 hike" / "1h 30 hike" / "1h30min hike" / "1h 30min hike" — hours + minutes combo
  let m = stripped.match(new RegExp(`^(\\d+)\\s*(?:h|hr|hrs|hour|hours)\\s*(\\d+)\\s*(?:min|mins|minute|minutes)?\\s+${ACTIVITY}\\b`, 'i'));
  if (m) {
    const mins = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    return makeActivityEvent(m[3], mins, body, dateKey);
  }

  // "1h hike" / "1.5h hike" / "2h cycle" — hours only
  m = stripped.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(?:h|hr|hrs|hour|hours)\\s+${ACTIVITY}\\b`, 'i'));
  if (m) {
    const mins = Math.round(parseFloat(m[1]) * 60);
    return makeActivityEvent(m[2], mins, body, dateKey);
  }

  // "30min cycle" / "40 min swim" / "45 minutes hike" — minutes only
  m = stripped.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(?:min|mins|minute|minutes)\\s+${ACTIVITY}\\b`, 'i'));
  if (m) {
    const mins = Math.round(parseFloat(m[1]));
    return makeActivityEvent(m[2], mins, body, dateKey);
  }

  return {
    reply: 'Didn\'t catch that. Try: "1h swim", "yesterday 1h hike", "monday 30min cycle", "1h30 hike", "lower body bio done".',
    event: null
  };
}

function makeActivityEvent(rawActivity, mins, originalBody, dateKey) {
  let activity = rawActivity.toLowerCase().trim();
  if (activity === 'bike' || activity === 'biking' || activity === 'cycling' || activity === 'ride' || activity === 'riding') activity = 'cycle';
  if (activity === 'hiking') activity = 'hike';
  if (activity === 'walking') activity = 'walk';
  if (activity === 'running' || activity === 'jog' || activity === 'jogging') activity = 'run';
  if (activity === 'swimming') activity = 'swim';
  if (activity === 'stretching') activity = 'stretch';
  if (/^spinning(\s+class)?$/.test(activity) || activity === 'spin') activity = 'spinning class';
  if (/^beach\s*bats$/.test(activity) || activity === 'matkot' || /^paddle\s*ball$/.test(activity)) activity = 'beach bats';

  const suffix = dateKey ? ` · ${prettyDate(dateKey)}` : '';
  return {
    reply: `logged ✓ ${activity} ${formatDuration(mins)}${suffix}`,
    event: { type: 'activity', activity, durationMin: mins, raw: originalBody.trim(), date: dateKey }
  };
}

function prettyDate(dateKey) {
  if (!dateKey) return '';
  if (dateKey === localToday()) return 'today';
  if (dateKey === localDateString(1)) return 'yesterday';
  const d = new Date(dateKey + 'T00:00:00Z');
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
}

function formatDuration(min) {
  if (!Number.isFinite(min) || min <= 0) return '';
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  if (rem === 0) return `${h}h`;
  return `${h}h ${rem}min`;
}

// ---------- Twilio send ----------

async function sendTwilio(env, to, body) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    throw new Error('missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN');
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const params = new URLSearchParams({
    From: TWILIO_FROM,
    To: to,
    Body: body
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`twilio ${res.status}: ${text.slice(0, 200)}`);
  }
}
