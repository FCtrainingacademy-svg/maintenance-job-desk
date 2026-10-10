// Contractor details: what a contractor may fill in themselves (sign-up form and
// "My details" on their job link), plus the self-billing agreement they accept.
const CATEGORIES = ["Plumbing / leak", "Heating / boiler", "Gas safety (CP12)", "Electrical", "Drainage / blockage", "Roofing / gutters", "Carpentry / doors / locks", "Damp & mould", "Decorating", "Appliance", "General repair", "Other"];
const CIS = ["none", "gross", "registered", "unregistered"];
const TEXT_FIELDS = { name: 80, company: 120, phone: 30, email: 120, address: 300, areas: 200, gasSafe: 30, insurance: 10,
  bankName: 80, sortCode: 12, accountNo: 12, utr: 15, niNumber: 13, companyNumber: 12, vatNumber: 20, rate: 10, callout: 10, about: 600 };
const AGREEMENT_VERSION = "2026-10";

function agreementText(biz) {
  const us = biz || "the Company";
  return [
    `Self-billing agreement between ${us} ("the Customer") and the subcontractor named below ("the Supplier").`,
    "1. The Supplier agrees that the Customer will raise invoices for work the Supplier carries out for the Customer (self-billed invoices).",
    "2. The Supplier will not issue its own sales invoices for that work.",
    "3. The Supplier will check each self-billed invoice and tell the Customer within 14 days if anything is wrong.",
    "4. If the Supplier is VAT registered, the Supplier will tell the Customer straight away if its VAT number changes, it deregisters for VAT, or it sells its business.",
    "5. Where the work falls under the Construction Industry Scheme (CIS), the Customer will deduct tax at the rate HMRC confirms and give the Supplier a monthly payment and deduction statement.",
    "6. This agreement lasts 12 months from the date accepted below, unless either party ends it earlier in writing.",
  ].join("\n");
}

const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

// Turn untrusted form input into the allowed contractor fields only.
function pickFields(body) {
  const out = {};
  for (const [k, max] of Object.entries(TEXT_FIELDS)) if (k in body) out[k] = clean(body[k], max);
  if ("cis" in body) out.cis = CIS.includes(body.cis) ? body.cis : "none";
  if ("vatRegistered" in body) out.vatRegistered = !!body.vatRegistered;
  if ("trades" in body) out.trades = (Array.isArray(body.trades) ? body.trades : []).filter(t => CATEGORIES.includes(t));
  return out;
}

function profileView(c, biz) {
  const v = {};
  for (const k of Object.keys(TEXT_FIELDS)) v[k] = c[k] || "";
  return { ...v, cis: c.cis || "none", vatRegistered: !!c.vatRegistered, trades: c.trades || [],
    selfBillAgreed: !!c.selfBillAgreed, selfBillDate: c.selfBillDate || "", selfBillSignedName: c.selfBillSignedName || "",
    agreement: agreementText(biz), categories: CATEGORIES };
}

module.exports = { pickFields, profileView, agreementText, AGREEMENT_VERSION, CATEGORIES };
