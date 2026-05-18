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

  const reply = parseReply(body);

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

// Very small rule-based parser. Designed to be replaced by an LLM later.
function parseReply(body) {
  const lower = body.toLowerCase().trim();

  if (!lower) return "Got an empty message.";

  // Greetings
  if (/^(hi|hello|hey|sup|yo)\b/.test(lower)) {
    return "Hey 👋 Message me when you've done a workout — e.g. \"did 40min swim\" — and I'll log it.";
  }

  // "did 40 min swim" / "completed 30min cycle" / "swam 25 minutes" etc.
  const m = lower.match(
    /(?:did|done|completed|finished|just|had)?\s*(\d+)\s*(?:min|mins|minute|minutes)?\s*(swim|cycle|ride|bike|walk|run|jog|bio|biokinetics|workout|stretch|yoga)/
  );
  if (m) {
    const mins = m[1];
    let activity = m[2];
    if (activity === 'bike') activity = 'cycle';
    if (activity === 'jog') activity = 'run';
    if (activity === 'biokinetics') activity = 'bio';
    return `logged ✓ ${activity} ${mins}min`;
  }

  // Pain-rating: "knees 7" / "lower back 4"
  const pain = lower.match(/^(knees?|back|lower back|shoulders?|neck|wrists?|hips?)\s*(\d{1,2})\b/);
  if (pain) {
    return `logged ✓ ${pain[1]} pain ${pain[2]}/10`;
  }

  return "Didn't catch that. Try: \"did 40min swim\", \"30min cycle\", or \"knees 7\".";
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
