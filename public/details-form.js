// Contractor details form shared by the public sign-up page (/join) and the
// "My details" tab on a contractor's personal job link.
window.DetailsForm = (function () {
  const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const CIS = [["none", "Not sure / not CIS"], ["registered", "CIS registered (20% deduction)"], ["unregistered", "Not CIS registered (30% deduction)"], ["gross", "Gross payment status (0%)"]];
  const f = (k, label, v, type, extra) => `<label class="f"><span>${label}</span><input id="df-${k}" data-k="${k}" type="${type || "text"}" value="${esc(v)}" ${extra || ""}></label>`;

  function html(o) {
    const v = o.values || {}, join = o.mode === "join", signed = v.selfBillAgreed;
    return `<form id="dform" class="board" novalidate>
      <section class="panel"><div class="panel-h"><h2>About you</h2></div><div class="panel-b">
        <div class="g">${f("name", "Full name *", v.name, "text", 'autocomplete="name" required')}${f("company", "Company / trading name", v.company, "text", 'autocomplete="organization"')}</div>
        <div class="g">${f("phone", "Mobile (WhatsApp)" + (join ? " *" : ""), v.phone, "tel", 'autocomplete="tel" inputmode="tel"' + (join ? " required" : ""))}${f("email", "Email", v.email, "email", 'autocomplete="email"')}</div>
        <label class="f"><span>Address</span><textarea id="df-address" data-k="address" autocomplete="street-address" style="min-height:56px">${esc(v.address)}</textarea></label>
      </div></section>
      <section class="panel"><div class="panel-h"><h2>Your work</h2></div><div class="panel-b">
        <div><span class="hint" style="text-transform:uppercase;font-weight:600;letter-spacing:.05em">Trades you cover</span>
          <div class="picklist" style="margin-top:4px">${(o.categories || []).map(c => `<label><input type="checkbox" data-trade="${esc(c)}" ${(v.trades || []).includes(c) ? "checked" : ""}> ${esc(c)}</label>`).join("")}</div></div>
        <div class="g">${f("areas", "Areas you cover (postcodes)", v.areas, "text", 'placeholder="e.g. IG1, IG2, E11, E17"')}${f("gasSafe", "Gas Safe number (if any)", v.gasSafe)}</div>
        <div class="g">${f("rate", "Usual hourly rate £", v.rate, "number", 'inputmode="decimal" min="0" step="0.01"')}${f("callout", "Usual call-out £", v.callout, "number", 'inputmode="decimal" min="0" step="0.01"')}${f("insurance", "Public liability insurance expiry", v.insurance, "date")}</div>
        ${join ? `<label class="f"><span>Anything else we should know?</span><textarea data-k="about" style="min-height:56px" placeholder="e.g. years of experience, own van, out-of-hours availability">${esc(v.about)}</textarea></label>` : ""}
      </div></section>
      <section class="panel"><div class="panel-h"><h2>Payment &amp; tax</h2><span class="hint">So we can pay you correctly</span></div><div class="panel-b">
        <div class="g">${f("bankName", "Name on bank account", v.bankName, "text", 'autocomplete="off"')}${f("sortCode", "Sort code", v.sortCode, "text", 'inputmode="numeric" placeholder="00-00-00"')}${f("accountNo", "Account number", v.accountNo, "text", 'inputmode="numeric" maxlength="12"')}</div>
        <div class="g"><label class="f"><span>CIS status</span><select data-k="cis">${CIS.map(([k, l]) => `<option value="${k}" ${String(v.cis || "none") === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
          ${f("utr", "UTR (10-digit tax reference)", v.utr, "text", 'inputmode="numeric" maxlength="15"')}${f("niNumber", "National Insurance number", v.niNumber, "text", 'maxlength="13" placeholder="AB123456C"')}${f("companyNumber", "Company number (if limited)", v.companyNumber)}</div>
        <div class="row"><label class="row" style="gap:6px"><input type="checkbox" data-k="vatRegistered" ${v.vatRegistered ? "checked" : ""}> VAT registered</label>${f("vatNumber", "VAT number", v.vatNumber)}</div>
        <p class="hint">Your UTR and NI number let us check your CIS status with HMRC. Without them we'd have to deduct tax at 30%.</p>
      </div></section>
      <section class="panel"><div class="panel-h"><h2>Self-billing agreement</h2>${signed ? `<span class="pill s-paid">Accepted ${esc(v.selfBillDate)}</span>` : ""}</div><div class="panel-b">
        <p class="hint">We raise your invoices for you, so you don't need to send any. Please read and accept:</p>
        <div class="callout" style="white-space:pre-line;font-size:13px">${esc(o.agreement)}</div>
        ${signed ? `<p class="hint">Accepted by ${esc(v.selfBillSignedName)} on ${esc(v.selfBillDate)}.</p>` :
          `<label class="row" style="gap:8px;align-items:flex-start"><input type="checkbox" id="df-agree" style="margin-top:4px"> <span>I accept the self-billing agreement</span></label>
           ${f("signedName", "Type your full name to sign", "", "text", 'autocomplete="name"')}`}
      </div></section>
      ${join ? `<label class="row" style="gap:8px;align-items:flex-start"><input type="checkbox" id="df-consent" style="margin-top:4px"> <span>I agree to receive job alerts and updates on WhatsApp at the number above. I can ask to stop at any time.</span></label>
        <div style="position:absolute;left:-5000px" aria-hidden="true"><input id="df-website" tabindex="-1" autocomplete="off"></div>` : ""}
      <div class="row"><button class="btn primary big" type="submit">${join ? "Send application" : "Save my details"}</button><span class="hint" id="df-msg"></span></div>
    </form>`;
  }

  function wire(root, onSubmit) {
    const form = root.querySelector("#dform");
    form.addEventListener("submit", async ev => {
      ev.preventDefault();
      const data = {};
      form.querySelectorAll("[data-k]").forEach(el => { data[el.dataset.k] = el.type === "checkbox" ? el.checked : el.value; });
      data.trades = [...form.querySelectorAll("[data-trade]")].filter(x => x.checked).map(x => x.dataset.trade);
      const agree = form.querySelector("#df-agree"), consent = form.querySelector("#df-consent"), hp = form.querySelector("#df-website");
      if (agree && agree.checked) { data.agree = true; data.signedName = (form.querySelector("#df-signedName") || {}).value || ""; }
      if (consent) data.consent = consent.checked;
      if (hp && hp.value) data.website = hp.value;
      const msg = form.querySelector("#df-msg"), btn = form.querySelector("button[type=submit]");
      if (agree && agree.checked && !data.signedName.trim()) { msg.textContent = "Type your full name to sign the agreement"; return; }
      btn.disabled = true; msg.textContent = "Saving…";
      try { await onSubmit(data); msg.textContent = ""; }
      catch (e) { msg.textContent = e.message || "Something went wrong – try again"; }
      finally { btn.disabled = false; }
    });
  }
  return { html, wire, esc };
})();
