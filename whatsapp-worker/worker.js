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

    if (url.pathname === '/events' && request.method === 'GET') {
      return handleEventsGet(request, env);
    }

    if (url.pathname === '/events' && request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === '/sms' && request.method === 'POST') {
      return handleInbound(request, env);
    }

    return new Response('not found', { status: 404 });
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
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
      const dateKey = localDateString();
      const id = (crypto.randomUUID && crypto.randomUUID()) || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
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

function localDateString() {
  const now = new Date(Date.now() + TZ_OFFSET_HOURS * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

// ---------- Parser ----------

export function parseMessage(body) {
  const lower = (body || '').toLowerCase().trim();
  if (!lower) return { reply: 'Got an empty message.', event: null };

  // Greetings
  if (/^(hi|hello|hey|sup|yo|howzit)\b/.test(lower)) {
    return {
      reply: 'Hey 👋 Try: "1h swim", "1h30 hike", "30min cycle", or "lower body bio done".',
      event: null
    };
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
    return {
      reply: `logged ✓ ${activity}`,
      event: { type: 'bio', activity, bodyPart: part || null, durationMin: null, raw: body.trim() }
    };
  }

  // ---- Activity with duration ----
  const ACTIVITY = '(swim|swimming|cycle|cycling|ride|riding|bike|biking|hike|hiking|walk|walking|run|running|jog|jogging|spinning(?:\\s+class)?|spin|yoga|stretch|stretching|workout|beach\\s*bats|matkot|padel|paddle\\s*ball)';

  // "1h30 hike" / "1h 30 hike" / "1h30min hike" / "1h 30min hike" — hours + minutes combo
  let m = stripped.match(new RegExp(`^(\\d+)\\s*(?:h|hr|hrs|hour|hours)\\s*(\\d+)\\s*(?:min|mins|minute|minutes)?\\s+${ACTIVITY}\\b`, 'i'));
  if (m) {
    const mins = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    return makeActivityEvent(m[3], mins, body);
  }

  // "1h hike" / "1.5h hike" / "2h cycle" — hours only
  m = stripped.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(?:h|hr|hrs|hour|hours)\\s+${ACTIVITY}\\b`, 'i'));
  if (m) {
    const mins = Math.round(parseFloat(m[1]) * 60);
    return makeActivityEvent(m[2], mins, body);
  }

  // "30min cycle" / "40 min swim" / "45 minutes hike" — minutes only
  m = stripped.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(?:min|mins|minute|minutes)\\s+${ACTIVITY}\\b`, 'i'));
  if (m) {
    const mins = Math.round(parseFloat(m[1]));
    return makeActivityEvent(m[2], mins, body);
  }

  return {
    reply: 'Didn\'t catch that. Try: "1h swim", "1h30 hike", "30min cycle", or "lower body bio done".',
    event: null
  };
}

function makeActivityEvent(rawActivity, mins, originalBody) {
  let activity = rawActivity.toLowerCase().trim();
  if (activity === 'bike' || activity === 'biking' || activity === 'cycling' || activity === 'ride' || activity === 'riding') activity = 'cycle';
  if (activity === 'hiking') activity = 'hike';
  if (activity === 'walking') activity = 'walk';
  if (activity === 'running' || activity === 'jog' || activity === 'jogging') activity = 'run';
  if (activity === 'swimming') activity = 'swim';
  if (activity === 'stretching') activity = 'stretch';
  if (/^spinning(\s+class)?$/.test(activity) || activity === 'spin') activity = 'spinning class';
  if (/^beach\s*bats$/.test(activity) || activity === 'matkot' || /^paddle\s*ball$/.test(activity)) activity = 'beach bats';

  return {
    reply: `logged ✓ ${activity} ${formatDuration(mins)}`,
    event: { type: 'activity', activity, durationMin: mins, raw: originalBody.trim() }
  };
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
