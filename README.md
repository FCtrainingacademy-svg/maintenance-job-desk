# Maintenance Job Desk

Property maintenance job desk for the office, with contractor dispatch over WhatsApp.

- **Office** (`/`, password login): log jobs and job sheets, keep clients and agents, keep contractors, post jobs, track them, invoice.
- **Contractors** (`/c/<personal link>`, no login): see posted jobs, accept (first wins) or quote, set their timeframe, update progress (booked → on the way → on site → complete), send notes, hand a job back.
- **WhatsApp**:
  - Contractors get job alerts with **Accept job** / **Not for me** buttons. Replying `YES PM-0012` also works.
  - Residents (and, if ticked on the job, the agent or landlord) get progress updates.

## Environment variables (Render → service → Environment)

| Variable | What it is |
|---|---|
| `OFFICE_PASSWORD` | Password for the office login. Required. |
| `SESSION_SECRET` | Long random string that signs login cookies. Render's blueprint generates one. |
| `DATABASE_URL` | Postgres connection string. Set automatically by the blueprint. Without it the app uses a local file (dev only). |
| `PUBLIC_URL` | Optional. Your own domain, e.g. `https://jobs.yourdomain.co.uk`. Defaults to the Render URL. Used in the links sent to contractors. |
| `WHATSAPP_TOKEN` | Permanent access token from Meta (System User token with `whatsapp_business_messaging`). |
| `WHATSAPP_PHONE_ID` | Phone number ID of the new maintenance number (WhatsApp Manager → API Setup). |
| `WHATSAPP_VERIFY_TOKEN` | Any string you choose. Enter the same one in Meta's webhook settings. |
| `WHATSAPP_APP_SECRET` | App secret (Meta app → Settings → Basic). Lets the app check that webhook calls really come from Meta. |
| `WHATSAPP_TEMPLATE_LANG` | Optional. Template language code. Default `en_GB`. |

Until `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_ID` are set, nothing is sent. Every message is listed under **Settings → WhatsApp messages** as "not sent". The job sheet still has one-tap WhatsApp buttons you can use by hand.

## WhatsApp setup (new number)

1. In Meta Business Suite → WhatsApp Manager, add a **new phone number** to your WhatsApp Business Account (the same account as the K's Plumbing Store bot is fine). Set its display name to your maintenance trading name.
2. Copy its **Phone number ID** into `WHATSAPP_PHONE_ID`. Use your System User token for `WHATSAPP_TOKEN`.
3. **Webhook.** In the Meta app → WhatsApp → Configuration:
   - Set the callback URL to `https://<your-app>/webhook`.
   - Set the verify token to your `WHATSAPP_VERIFY_TOKEN`.
   - Subscribe to the `messages` field.

   If the K's Plumbing Store bot already uses this Meta app's webhook, create a separate Meta app for the maintenance number. Each app has one callback URL.
4. Create these three **message templates** (category **Utility**, language English (UK)). Names must match exactly.

**`new_job_alert`**, with two **Quick reply** buttons: `Accept job` and `Not for me`

```
New job {{1}} – {{2}}
{{3}} in the {{4}} area
{{5}}
Attend by: {{6}}
{{7}}
Your job link: {{8}}
```

**`job_assigned`**

```
Job {{1}} is yours.
Address: {{2}}
Attend by {{3}}. Agreed price {{4}}.
Please set your attend time and update progress here: {{5}}
```

**`job_update`**, sent to residents and the agent or landlord

```
Hi {{1}}, here's an update on the repair at {{2}} (ref {{3}}):
{{4}}
Questions? Contact {{5}} on {{6}}.
```

Meta usually approves Utility templates within minutes to a few hours. Business-initiated messages need an approved template. Free-text replies (like "Job PM-0012 is yours…") only go out within 24 hours of the contractor's last message, which is always the case when they've just tapped a button.

**Consent:** only message contractors, residents and agents who expect messages from you. The contractor invite asks them to reply OK. For residents, tell the agent or landlord that tenants will get WhatsApp updates about their repair.

## Running locally

```
npm install
OFFICE_PASSWORD=test npm start           # http://localhost:3000, data in data/dev-db.json
OFFICE_PASSWORD=test PORT=3999 npm start & BASE=http://localhost:3999 OFFICE_PASSWORD=test npm test
```

`npm test` runs the end-to-end checks:
- office login;
- posting a job;
- two contractors accepting at the same moment;
- privacy of job details before acceptance;
- timeframe and progress steps;
- resident and agent updates;
- quotes;
- WhatsApp button and text replies;
- handing a job back.
