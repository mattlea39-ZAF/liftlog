// Lift.Log WhatsApp Worker (Cloudflare)
//
// Routes:
//   GET  /          → health check
//   POST /sms       → Twilio webhook for inbound WhatsApp messages
//
// Required environment variables (stored as Worker secrets, not in code):
//   TWILIO_ACCOUNT_SID     e.g. AC...
//   TWILIO_AUTH_TOKEN      the Twilio auth token
//
// Twilio sandbox "from" number is the same for every Twilio account: +14155238886.

const TWILIO_FROM = 'whatsapp:+14155238886';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('lift.log whatsapp worker — ok', { status: 200 });
    }

    if (url.pathname === '/sms' && request.method === 'POST') {
      return handleInbound(request, env);
    }

    return new Response('not found', { status: 404 });
  }
};

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

  console.log('inbound:', JSON.stringify({ from, body, sidPresent: !!env.TWILIO_ACCOUNT_SID, tokenPresent: !!env.TWILIO_AUTH_TOKEN }));

  const { reply, event } = parseMessage(body);
  if (event) console.log('event:', JSON.stringify(event));

  // Reply via Twilio's REST API (out-of-band; the webhook response itself
  // could also return TwiML, but the REST path is simpler to extend later).
  try {
    await sendTwilio(env, from, reply);
  } catch (err) {
    console.error('sendTwilio failed:', err && err.message, err && err.stack);
    return new Response('twilio send failed: ' + (err && err.message), { status: 500 });
  }

  // Twilio is happy with an empty 200.
  return new Response('', { status: 200 });
}

// Rule-based parser. Designed to be replaced/augmented by an LLM later.
//
// Recognises:
//   "1h swim", "40min swim", "did a 40 min swim", "did 1h cycle"
//   "2h hike", "1h spinning class", "1h spinning", "1h cycle", "1h ride"
//   "legs bio session done", "back bio", "bio session done"
//   "knees 7", "lower back 4"  (pain ratings 0-10)
//   "hi" / "hello" / "hey"     (greeting)
//
// Returns: { reply, event | null }
//   event has shape { activity, durationMin, raw } for activity logs,
//                  { activity: '<part> bio', durationMin: null } for bio,
//                  { painPoint, score } for pain ratings.
// Phase 2 will persist `event` to KV; Phase 1 ignores it.
export function parseMessage(body) {
  const lower = (body || '').toLowerCase().trim();
  if (!lower) return { reply: "Got an empty message.", event: null };

  // Greetings
  if (/^(hi|hello|hey|sup|yo|howzit)\b/.test(lower)) {
    return {
      reply: 'Hey 👋 Tell me what you did — e.g. "1h swim", "40min cycle", "2h hike", or "legs bio session done".',
      event: null
    };
  }

  // Pain rating: "knees 7", "lower back 4", "neck 3"
  const pain = lower.match(/^(knees?|lower back|back|shoulders?|neck|wrists?|hips?)\s*(\d{1,2})\b/);
  if (pain) {
    const score = Math.min(10, Math.max(0, parseInt(pain[2], 10)));
    return {
      reply: `logged ✓ ${pain[1]} pain ${score}/10`,
      event: { type: 'pain', painPoint: pain[1], score }
    };
  }

  // Bio session: "legs bio session done", "back bio", "bio session done", "chest bio session completed"
  const bio = lower.match(
    /^(?:did\s+(?:a\s+)?|completed\s+|finished\s+|just\s+)?(legs?|back|chest|arms?|shoulders?|core|full[- ]?body)?\s*bio(?:kinetics)?(?:\s+session)?(?:\s+done|\s+completed|\s+finished)?\s*$/
  );
  if (bio) {
    const part = (bio[1] || '').replace(/\s+/g, ' ').trim();
    const label = part ? `${part} bio` : 'bio';
    return {
      reply: `logged ✓ ${label} session`,
      event: { type: 'activity', activity: label + ' session', durationMin: null, raw: body.trim() }
    };
  }

  // Activity with explicit duration
  // Examples it must match:
  //   "1h swim", "40min swim", "did a 40 min swim", "did 1h cycle"
  //   "2h hike", "1h spinning class", "1h spinning", "1h cycle", "1h ride"
  const activityRe = new RegExp(
    // optional polite prefix
    '^(?:did|done|completed|finished|just|had|just\\s+did)?\\s*(?:a\\s+)?' +
    // duration: number + optional space + unit (h/hour/hours/min/minute/minutes)
    '(\\d+(?:\\.\\d+)?)\\s*(h|hr|hrs|hour|hours|min|mins|minute|minutes)\\s+' +
    // activity
    '(swim|swimming|cycle|cycling|ride|riding|bike|biking|hike|hiking|walk|walking|run|running|jog|jogging|spin|spinning(?:\\s+class)?|yoga|stretch|stretching|workout)' +
    '\\b',
    'i'
  );
  const m = lower.match(activityRe);
  if (m) {
    const num = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    const minutes = unit.startsWith('h') ? Math.round(num * 60) : Math.round(num);

    let activity = m[3].toLowerCase();
    if (activity === 'bike' || activity === 'biking' || activity === 'cycling' || activity === 'ride' || activity === 'riding') activity = 'cycle';
    if (activity === 'hiking') activity = 'hike';
    if (activity === 'walking') activity = 'walk';
    if (activity === 'running' || activity === 'jog' || activity === 'jogging') activity = 'run';
    if (activity === 'swimming') activity = 'swim';
    if (activity === 'stretching') activity = 'stretch';
    if (/^spinning(\s+class)?$/.test(activity)) activity = 'spinning class';
    if (activity === 'spin') activity = 'spinning class';

    return {
      reply: `logged ✓ ${activity} ${formatDuration(minutes)}`,
      event: { type: 'activity', activity, durationMin: minutes, raw: body.trim() }
    };
  }

  return {
    reply: 'Didn\'t catch that. Try: "1h swim", "40min cycle", "2h hike", "legs bio session done", or "knees 7".',
    event: null
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
