// WhatsApp Cloud API. Without WHATSAPP_TOKEN + WHATSAPP_PHONE_ID every message is
// recorded in the "outbox" collection instead (simulated), so the app works before
// the number is set up and the office can see what would have been sent.
const env = process.env;
const API = `${env.WHATSAPP_API_BASE || "https://graph.facebook.com"}/${env.WHATSAPP_API_VERSION || "v21.0"}`;
const T_NEW = env.TEMPLATE_NEW_JOB || "new_job_alert";
const T_ASSIGNED = env.TEMPLATE_JOB_ASSIGNED || "job_assigned";
const LANG = env.WHATSAPP_TEMPLATE_LANG || "en_GB";

const enabled = () => !!(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID);

function intl(ph) {
  let d = String(ph || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1); else if (d.startsWith("00")) d = d.slice(2); else if (d.startsWith("0")) d = "44" + d.slice(1);
  return d;
}
// Template parameters may not contain new lines, tabs or long runs of spaces.
const clean = (s, max = 300) => { s = String(s == null ? "" : s).replace(/\s+/g, " ").trim() || "-"; return s.length > max ? s.slice(0, max - 1) + "…" : s; };

function makeWhatsApp(store) {
  async function record(entry) {
    const id = Date.now() + "-" + Math.random().toString(36).slice(2, 7);
    await store.put("outbox", id, { ...entry, at: new Date().toISOString() });
    // keep the newest 150
    const all = await store.list("outbox");
    if (all.length > 150) {
      const old = all.sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(0, all.length - 150);
      for (const o of old) await store.del("outbox", o.id);
    }
  }
  async function send(to, payload, summary) {
    const toN = intl(to);
    if (!toN) return { ok: false, error: "No mobile number" };
    if (!enabled()) { await record({ to: toN, summary, simulated: true }); return { ok: true, simulated: true }; }
    try {
      const r = await fetch(`${API}/${env.WHATSAPP_PHONE_ID}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to: toN, ...payload }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const error = (j.error && (j.error.error_data && j.error.error_data.details || j.error.message)) || `HTTP ${r.status}`;
        await record({ to: toN, summary, error });
        return { ok: false, error };
      }
      await record({ to: toN, summary, sent: true });
      return { ok: true };
    } catch (e) { await record({ to: toN, summary, error: e.message }); return { ok: false, error: e.message }; }
  }
  const text = (to, body) => send(to, { type: "text", text: { body, preview_url: true } }, body);
  function template(to, name, params, buttonPayloads, summary) {
    const components = [{ type: "body", parameters: params.map(p => ({ type: "text", text: clean(p) })) }];
    (buttonPayloads || []).forEach((pl, i) => components.push({ type: "button", sub_type: "quick_reply", index: String(i), parameters: [{ type: "payload", payload: pl }] }));
    return send(to, { type: "template", template: { name, language: { code: LANG }, components } }, summary);
  }
  return { enabled, intl, text, template, T_NEW, T_ASSIGNED };
}

module.exports = { makeWhatsApp, intl };
