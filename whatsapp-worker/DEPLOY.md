# Deploy the Lift.Log WhatsApp Worker (no CLI needed)

This is a one-time setup. After deploy, messaging the Twilio sandbox should round-trip through this Worker.

## 1. Create the Worker

1. Go to https://dash.cloudflare.com → **Workers & Pages**.
2. Click **Create application** → **Create Worker** (or just "Create" → "Worker").
3. Name: `liftlog-whatsapp` (or anything; the name becomes part of the URL).
4. Click **Deploy** to publish the default "Hello World" stub.

## 2. Paste the real code

1. From the Worker's overview page, click **Edit code** (top-right).
2. Delete everything in the editor.
3. Open `worker.js` from this folder and paste its full contents into the editor.
4. Click **Save and deploy**.

## 3. Add the Twilio credentials as Worker secrets

Important: the Twilio Auth Token must be a **secret**, not a plain env var.

1. Back on the Worker's overview, click **Settings** → **Variables**.
2. Under **Environment Variables** (or **Variables and Secrets**) click **Add variable** and add these two — **toggle "Encrypt" / "Secret" for both**:
   - `TWILIO_ACCOUNT_SID` = your Twilio Account SID (the `AC…` value)
   - `TWILIO_AUTH_TOKEN` = your Twilio Auth Token
3. Click **Save and deploy**.

## 4. Note the Worker URL

On the Worker overview, copy the URL — something like:

```
https://liftlog-whatsapp.<your-cloudflare-subdomain>.workers.dev
```

Quick check: open `<that URL>/health` in your browser. You should see `lift.log whatsapp worker — ok`.

## 5. Point the Twilio sandbox at the Worker

1. Go to https://console.twilio.com.
2. Left nav → **Messaging** → **Try it out** → **Send a WhatsApp message**.
3. Scroll to **Sandbox Configuration** (might be under a "Sandbox settings" tab).
4. Set **WHEN A MESSAGE COMES IN** to:
   ```
   https://liftlog-whatsapp.<your-cloudflare-subdomain>.workers.dev/sms
   ```
5. Method: **HTTP POST**.
6. Click **Save**.

## 6. Test it

From your phone, on the WhatsApp you sent the `join …` code from earlier, message the Twilio sandbox number (`+1 415 523 8886`):

- `did 40min swim` → should reply `logged ✓ swim 40min`
- `30min cycle` → `logged ✓ cycle 30min`
- `knees 7` → `logged ✓ knees pain 7/10`
- `hi` → friendly intro

If nothing comes back, in Cloudflare → your Worker → **Logs** tab (top), click **Begin log stream**, message again, and watch for errors.

## 7. Once it works — rotate credentials

The Twilio Auth Token and Cloudflare API Token you pasted into chat are in the conversation transcript. Rotate them:

- **Twilio**: Console → **Account** (top-right avatar) → **API keys & tokens** → create a new Auth Token, update the Worker secret (`TWILIO_AUTH_TOKEN`), then revoke the old one.
- **Cloudflare**: https://dash.cloudflare.com/profile/api-tokens → roll the token. (Not currently used by the Worker itself, but it could deploy on your behalf — rolling closes that door.)
