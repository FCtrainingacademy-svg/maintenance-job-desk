// K's Plumbing Store link: search its catalogue for job materials, and place trade orders for
// approved materials. Needs KPS_API_KEY (= JOBDESK_API_KEY on the store) and optionally KPS_URL
// (default https://ksplumbingstore.co.uk). Without the key the desk falls back to copy/paste orders.
const env = process.env;
const base = () => (env.KPS_URL || "https://ksplumbingstore.co.uk").replace(/\/$/, "");
const enabled = () => !!env.KPS_API_KEY;

async function call(method, path, body) {
  if (!enabled()) return { error: "K's Plumbing Store isn't linked yet (KPS_API_KEY)." };
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(base() + path, { method, signal: ctl.signal,
      headers: { "X-Jobdesk-Key": env.KPS_API_KEY, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { error: j.error || `K's Plumbing Store error ${r.status}` };
    return j;
  } catch (e) {
    return { error: e.name === "AbortError" ? "K's Plumbing Store didn't answer – try again" : "Can't reach K's Plumbing Store – try again" };
  } finally { clearTimeout(t); }
}

const search = q => call("GET", "/api/bot/jobdesk/catalog?q=" + encodeURIComponent(String(q || "").slice(0, 80)));
const order = body => call("POST", "/api/bot/jobdesk/order", body);
const statuses = refs => call("GET", "/api/bot/jobdesk/orders?refs=" + encodeURIComponent(refs.join(",")));

module.exports = { enabled, search, order, statuses, base };
