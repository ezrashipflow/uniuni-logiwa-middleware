/**
 * UniUni eCommerce <-> Logiwa Custom Carrier Middleware v1.1.0
 * Changes from v1.0.9:
 *   - Hazmat rules from UniUni's Hazardous Materials Shipping Guide: a hazmat
 *     order gets no rate and no label when it is going outside the contiguous
 *     U.S., weighs over 30 lb, or holds a class / UN number UniUni prohibits.
 *     Other hazmat orders rate and label as before.
 *   - A hazmat label is followed by a second label, in the same PDF / ZPL,
 *     carrying the Limited Quantity mark for the carton.
 *
 * Changes in v1.0.9:
 *   - Carrier code is now 'Uni Uni' (was 'UNIUNI-REG') to match the Logiwa
 *     custom carrier code. Logiwa sends carrier:null on /get-rate, so this
 *     fallback is what it matches the returned rate against — once the Logiwa
 *     code was renamed to 'Uni Uni', every quote was discarded and UniUni
 *     stopped winning rate shops (last label 2026-09-22 20:51).
 *     'Uni Uni' is also Shopify's recognized tracking company string, so the
 *     carrier now flows through to Shopify with native clickable tracking.
 *
 * Changes in v1.0.8:
 *   - Reduced logging verbosity to avoid Railway rate limit (no more full payload dumps)
 *   - Label format now dynamic: reads from Logiwa labelSpecification (PDF or ZPL), defaults to PDF
 *   - ZPL: labelFormat=zpl, type=base64, responseType=json
 *   - PDF: labelFormat=pdf, type=pdf, responseType=arraybuffer
 */
const express = require('express');
const axios   = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '10mb' }));

const UNIUNI_CLIENT_ID     = process.env.UNIUNI_CLIENT_ID;
const UNIUNI_CLIENT_SECRET = process.env.UNIUNI_CLIENT_SECRET;
const UNIUNI_CUSTOMER_NO   = process.env.UNIUNI_CUSTOMER_NO;
const UNIUNI_WAREHOUSE_ID  = process.env.UNIUNI_WAREHOUSE_ID;
const PORT = process.env.PORT || 3000;

const UNIUNI_BASE_URL = 'https://prm-api.uniuni.com';

const MIDDLEWARE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
  : (process.env.MIDDLEWARE_URL || 'https://uniuni-logiwa-middleware-production.up.railway.app');

const labelCache = {};
let cachedToken = null;
let tokenExpiry = 0;

// ─── LOGGING ──────────────────────────────────────────────────────────────────
// Carrier API calls only — no full Logiwa payload dumps (causes Railway log rate limit)

function logRequest(tag, method, url, body) {
  console.log('\n' + '─'.repeat(60));
  console.log('[' + tag + '] ► REQUEST  ' + method + ' ' + url);
  if (body) console.log('[' + tag + ']   BODY:\n' + JSON.stringify(body, null, 2));
}

function logResponse(tag, status, data) {
  console.log('[' + tag + '] ◄ RESPONSE status=' + status);
  const body = JSON.stringify(data, null, 2);
  console.log('[' + tag + ']   BODY:\n' + body.slice(0, 1000) + (body.length > 1000 ? '\n...[truncated]' : ''));
  console.log('─'.repeat(60) + '\n');
}

function logError(tag, error) {
  console.error('[' + tag + '] ✗ ERROR');
  if (error.response) {
    console.error('[' + tag + ']   HTTP STATUS : ' + error.response.status);
    console.error('[' + tag + ']   RESPONSE BODY:\n' + JSON.stringify(error.response.data, null, 2));
  } else {
    console.error('[' + tag + ']   MESSAGE: ' + error.message);
  }
  console.error('─'.repeat(60) + '\n');
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

async function getUniUniToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  logRequest('AUTH', 'POST', UNIUNI_BASE_URL + '/storeauth/customertoken', {
    grant_type: 'client_credentials',
    client_id: UNIUNI_CLIENT_ID,
    client_secret: '***REDACTED***',
  });

  try {
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', UNIUNI_CLIENT_ID);
    params.append('client_secret', UNIUNI_CLIENT_SECRET);

    const r = await axios.post(
      UNIUNI_BASE_URL + '/storeauth/customertoken',
      params,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const token = r.data.data.access_token;
    if (!token) throw new Error('No access_token in auth response: ' + JSON.stringify(r.data));

    logResponse('AUTH', r.status, { access_token: '***REDACTED***', expires_in: r.data.data.expires_in });
    cachedToken = token;
    tokenExpiry = Date.now() + 55 * 60 * 1000;
    console.log('[AUTH] UniUni token refreshed successfully');
    return cachedToken;
  } catch (e) { logError('AUTH', e); throw e; }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function parseLogiwaBody(body) { return Array.isArray(body) ? body : [body]; }

function getAddr(obj) {
  if (!obj) return {};
  const a = obj.address || obj;
  return {
    address1:   a.AddressLine1 || a.addressLine1 || '',
    address2:   a.AddressLine2 || a.addressLine2 || '',
    city:       a.City         || a.city         || '',
    state:      a.StateOrProvinceCode || a.stateOrProvinceCode || '',
    postalCode: a.PostalCode   || a.postalCode   || '',
    country:    a.CountryCode  || a.countryCode  || 'US',
  };
}

function getContact(obj) {
  if (!obj) return {};
  const c = obj.contact || obj;
  return {
    name:  c.personName   || c.name    || '',
    phone: c.phoneNumber  || c.phone   || '',
    email: c.emailAddress || c.email   || '',
  };
}

function weightToLB(value, unit) {
  const v = parseFloat(value) || 0;
  const u = (unit || 'LB').toUpperCase();
  let lb;
  if      (u === 'OZ') lb = v / 16;
  else if (u === 'G')  lb = v / 453.592;
  else if (u === 'KG') lb = v * 2.20462;
  else                 lb = v;
  return Math.max(Math.ceil(lb * 100) / 100, 0.01);
}

function buildFullAddress(addr) {
  const parts = [addr.address1];
  if (addr.address2) parts.push(addr.address2);
  parts.push(addr.city + ', ' + addr.state + ' ' + addr.postalCode);
  return parts.join(', ');
}

/**
 * Resolve label format from Logiwa's labelSpecification.
 * Logiwa sends labelFileType: "PDF" or "ZPL"
 *
 * UniUni printlabel params:
 *   labelFormat: "pdf" | "zpl"
 *   type:        "pdf" (raw binary stream) | "base64" (JSON wrapper, used for ZPL)
 *   labelType:   6 = 4x6 inch
 */
function resolveLabelFormat(order) {
  const raw = (
    order.labelSpecification?.labelFileType ||
    order.labelSpecification?.labelFormat   ||
    'PDF'
  ).toUpperCase();

  if (raw === 'ZPL') {
    return {
      format:       'zpl',
      labelType:    6,
      type:         'base64',
      mimeType:     'application/x-zebra',
      responseType: 'json',
    };
  }
  // Default PDF
  return {
    format:       'pdf',
    labelType:    6,
    type:         'pdf',
    mimeType:     'application/pdf',
    responseType: 'arraybuffer',
  };
}

const DEFAULT_FROM = {
  address1: '625 Jersey Ave, Unit 9',
  city: 'New Brunswick', state: 'NJ', postalCode: '08901', country: 'US',
  name: 'ShipFlow', phone: '9085253857', email: 'info@shipflow.co',
};

// ─── HAZMAT ───────────────────────────────────────────────────────────────────
// Logiwa flags hazmat per product (isHazardous + hazmat* fields) on each box's
// products[] and on internationalOptions.customsItems.
//
// UniUni carries a limited list of hazmat by ground (UniUni Hazardous Materials
// Shipping Guide). Its API has no hazmat field: the declaration is the marks on
// the carton plus the signed "UniUni Hazardous Materials Shipping Certification"
// attached to it — warehouse work, not something this service can send. What we
// can do here is refuse the orders the guide rules out, so they get no rate
// (and drop out of Logiwa's rate shop) and no label:
//   - §2.3  contiguous U.S. only — not Alaska, Hawaii, territories or abroad
//   - §3.1.4 package over 30 lb
//   - §2.1  prohibited classes and UN numbers
//   - an aerosol (UN1950) without class 2.1 or 2.2 set. The guide's rules list
//     aerosols under 2.2 only, but its own sample certification (p.19) ships a
//     2.1 aerosol as Limited Quantity, and ShipFlow ships 2.1 aerosols here.
// We also refuse what we can't mark or don't vouch for: lithium batteries in
// equipment (no lithium battery mark is printed here), Fully Regulated items,
// and a hazmat product with no UN number or class in Logiwa.

const HAZMAT_MAX_LB = 30;
const NON_CONTIGUOUS = ['AK', 'HI', 'PR', 'GU', 'VI', 'AS', 'MP', 'AA', 'AE', 'AP'];
// §2.1 + Appendix A: standalone lithium (3480 / 3090), lighters, fireworks,
// gasoline, matches, mercury, compressed gas.
const PROHIBITED_UN = ['3480', '3090', '1057', '0336', '0337', '1203', '1944', '1331', '2809', '1956'];

function isHazmatLine(p) {
  return !!p && (p.isHazardous === true || String(p.isHazardous).toLowerCase() === 'true'
    || !!p.hazmatIdentificationNumber || !!p.hazmatClassDivisionNumber);
}

function orderProducts(order) {
  const boxes = Array.isArray(order.requestedPackageLineItems) ? order.requestedPackageLineItems : [];
  const customs = order.internationalOptions?.customsItems;
  return boxes.flatMap(b => Array.isArray(b.products) ? b.products : [])
    .concat(Array.isArray(customs) ? customs : []);
}

// SKUs of the hazmat items on the order; empty when there are none.
function hazmatSkus(order) {
  return [...new Set(orderProducts(order).filter(isHazmatLine).map(p => p.sku || p.description || 'unknown SKU'))];
}

// §2.1: classes UniUni never carries. 2.2, 3, 5.1, 8 and 9 are restricted
// carriage (allowed on conditions). Other 2.1 gases are prohibited; a 2.1
// aerosol (UN1950) is let through by hazmatRefusal.
function prohibitedClass(raw) {
  const m = String(raw || '').match(/(\d)(?:\.(\d))?/);
  if (!m) return null;
  const cls = m[1], div = m[2];
  if (['1', '4', '6', '7'].includes(cls)) return 'Class ' + cls;
  if (cls === '2' && div !== '2') return 'Class 2' + (div ? '.' + div : '') + ' gas';
  if (cls === '5' && div === '2') return 'Class 5.2';
  return null;
}

// Why UniUni cannot take this order's hazmat, or null when it can (or there is none).
function hazmatRefusal(order) {
  const lines = orderProducts(order).filter(isHazmatLine);
  if (!lines.length) return null;
  const label = 'Hazmat item on order (' + hazmatSkus(order).join(', ') + ') — UniUni ';

  const to = getAddr(order.shipTo);
  const state = String(to.state || '').toUpperCase();
  if (String(to.country || 'US').toUpperCase() !== 'US' || NON_CONTIGUOUS.includes(state)) {
    return label + 'carries hazmat within the contiguous U.S. only, not to ' + (state || to.country);
  }

  for (const box of (order.requestedPackageLineItems || [])) {
    const lb = weightToLB(box.weight?.Value || box.weight?.value, box.weight?.Units || box.weight?.units);
    if (lb > HAZMAT_MAX_LB) return label + 'takes hazmat packages up to ' + HAZMAT_MAX_LB + ' lb, this one is ' + lb + ' lb';
  }

  for (const p of lines) {
    const sku = p.sku || 'item';
    const un = String(p.hazmatIdentificationNumber || '').replace(/\D/g, '').padStart(4, '0');
    if (!p.hazmatIdentificationNumber && !p.hazmatClassDivisionNumber) return label + 'needs the UN number and class — ' + sku + ' has neither in Logiwa';
    if (p.hazmatIdentificationNumber && PROHIBITED_UN.includes(un)) return label + 'does not carry UN' + un + ' (' + sku + ')';
    if (LITHIUM_UN.includes(un)) return label + 'is not sent lithium batteries (UN' + un + ', ' + sku + ') — no lithium battery mark is printed';
    if (String(p.hazmatTypeName || '').trim().toUpperCase() === 'FR') return label + 'is not sent Fully Regulated hazmat (' + sku + ')';
    const aerosol = un === '1950';
    if (aerosol && !/^\s*2\.[12]\b/.test(String(p.hazmatClassDivisionNumber || ''))) return label + 'needs the aerosol class (2.1 or 2.2) — ' + sku + ' has none set in Logiwa';
    const cls = !aerosol && prohibitedClass(p.hazmatClassDivisionNumber);
    if (cls) return label + 'does not carry ' + cls + ' (' + sku + ')';
    // §2.1 / §2.2: class 9 is carried only as dry ice or batteries in equipment (refused above).
    if (/^\s*9\b/.test(String(p.hazmatClassDivisionNumber || '')) && un !== '1845') return label + 'carries class 9 only as dry ice or batteries in equipment (' + sku + ', UN' + un + ')';
  }
  return null;
}

// ─── LIMITED QUANTITY MARK ────────────────────────────────────────────────────
// A hazmat carton going UniUni must carry the Limited Quantity mark (49 CFR
// §172.315; UniUni guide §4.2.1): a square on point, top and bottom corners
// black, centre white. We print it as a second label straight after the
// shipping label, in the same file, so the packer gets both from one print.
//
// Size: the rule is 100 mm per side, or no less than 50 mm where the package
// is too small for that. A 4x6 label is 101.6 mm wide, so the largest mark it
// can hold is about 63 mm per side — the reduced size, right for small parcels.
//
// Lithium batteries (UN3481 / UN3091) take the lithium battery mark instead,
// which needs a UN number and phone number; we do not print that one.

const LITHIUM_UN = ['3481', '3091'];

const SMALL_QTY_TYPES = (process.env.SMALL_QTY_HAZMAT_TYPES || 'EQ')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const SMALL_QTY_STATEMENT = 'This package conforms to 49 CFR 173.4 for domestic highway or rail transport only.';

function isSmallQuantityLine(p) {
  const type = String(p.hazmatTypeName || p.hazmatType || '').trim().toUpperCase();
  return SMALL_QTY_TYPES.includes(type)
    || /173\.4\b|small\s+quantit/i.test(p.hazmatShippingName || '');
}

// Breaks text into lines no wider than `room` at the given size.
function wrapText(text, measure, room) {
  const out = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const last = out[out.length - 1];
    if (last !== undefined && measure(last + ' ' + word) <= room) out[out.length - 1] = last + ' ' + word;
    else out.push(word);
  }
  return out;
}

// Which mark the order's hazmat takes: 'LQ', 'SQ' or null.
function hazmatMarkFor(order) {
  const lines = orderProducts(order).filter(isHazmatLine)
    .filter(p => !LITHIUM_UN.includes(String(p.hazmatIdentificationNumber || '').replace(/\D/g, '')));
  if (!lines.length) return null;
  return lines.every(isSmallQuantityLine) ? 'SQ' : 'LQ';
}

// The mark as plain geometry, in whatever unit the caller draws in.
//   r = half the diagonal, t = border thickness, a = half-height of the white band
function lqGeometry(width, height, margin, t) {
  const r  = Math.min(width, height) / 2 - margin;
  const cx = width / 2, cy = height / 2;
  const a  = r * 0.5;
  const ri = r - t * Math.SQRT2;          // inner (white) diamond, inset by the border
  return { r, cx, cy, a, ri, t };
}

async function lqMarkPdf(pdfBase64, caption) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const doc   = await PDFDocument.load(Buffer.from(pdfBase64, 'base64'));
  const first = doc.getPage(0).getSize();
  const page  = doc.addPage([first.width, first.height]);
  const { width: W, height: H } = first;
  const mm = 72 / 25.4;
  const g  = lqGeometry(W, H, 6 * mm, 2 * mm);
  const P  = (pts) => 'M ' + pts.map(([x, y]) => x.toFixed(2) + ' ' + y.toFixed(2)).join(' L ') + ' Z';
  // SVG path space: origin top-left of the page, y down.
  const at = { x: 0, y: H };
  page.drawSvgPath(P([[g.cx, g.cy - g.r], [g.cx + g.r, g.cy], [g.cx, g.cy + g.r], [g.cx - g.r, g.cy]]), { ...at, color: rgb(0, 0, 0) });
  const w = g.ri - g.a;                    // half-width of the white band at its top and bottom
  page.drawSvgPath(P([[g.cx - w, g.cy - g.a], [g.cx + w, g.cy - g.a], [g.cx + g.ri, g.cy], [g.cx + w, g.cy + g.a], [g.cx - w, g.cy + g.a], [g.cx - g.ri, g.cy]]), { ...at, color: rgb(1, 1, 1) });
  // One caption line per entry, centred; the size drops until the widest fits.
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const room = W - 2 * 4 * mm;
  let size = 14;
  while (size > 6 && Math.max(...caption.map(l => font.widthOfTextAtSize(l, size))) > room) size -= 0.5;
  caption.forEach((line, i) => {
    const y = 7 * mm + (caption.length - 1 - i) * size * 1.25;
    page.drawText(line, { x: (W - font.widthOfTextAtSize(line, size)) / 2, y, size, font, color: rgb(0, 0, 0) });
  });
  return Buffer.from(await doc.save()).toString('base64');
}

// The Small Quantity page: the 173.4 statement, large and centred, with the
// order code under it.
async function sqMarkPdf(pdfBase64, orderCode) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const doc   = await PDFDocument.load(Buffer.from(pdfBase64, 'base64'));
  const { width: W, height: H } = doc.getPage(0).getSize();
  const page  = doc.addPage([W, H]);
  const mm    = 72 / 25.4;
  const font  = await doc.embedFont(StandardFonts.HelveticaBold);
  const room  = W - 2 * 8 * mm;
  const size  = 20;
  const lines = wrapText(SMALL_QTY_STATEMENT, l => font.widthOfTextAtSize(l, size), room);
  const lead  = size * 1.3;
  let y = H / 2 + (lines.length * lead) / 2;
  page.drawRectangle({ x: 5 * mm, y: y - lines.length * lead - 4 * mm, width: W - 10 * mm, height: lines.length * lead + 10 * mm, borderColor: rgb(0, 0, 0), borderWidth: 2 });
  for (const line of lines) {
    y -= lead;
    page.drawText(line, { x: (W - font.widthOfTextAtSize(line, size)) / 2, y: y + lead * 0.25, size, font, color: rgb(0, 0, 0) });
  }
  if (orderCode) {
    let s = 14;
    while (s > 6 && font.widthOfTextAtSize(orderCode, s) > W - 8 * mm) s -= 0.5;
    page.drawText(orderCode, { x: (W - font.widthOfTextAtSize(orderCode, s)) / 2, y: 7 * mm, size: s, font, color: rgb(0, 0, 0) });
  }
  return Buffer.from(await doc.save()).toString('base64');
}

function sqMarkZpl(label, orderCode) {
  const plain = String(label).includes('^XA');
  const zpl   = plain ? String(label) : Buffer.from(String(label), 'base64').toString('utf8');
  if (!zpl.includes('^XA')) throw new Error('label is not ZPL text');
  const pw  = parseInt((zpl.match(/\^PW(\d+)/) || [])[1], 10) || 812;
  const dpm = pw / 101.6;
  const W = pw, H = Math.round(pw * 1.5);
  const clean = s => String(s).replace(/[\^~\\]/g, ' ');
  const out = ['^XA', '^PW' + W, '^LL' + H, '^LH0,0',
    '^FO' + Math.round(5 * dpm) + ',' + Math.round(H / 2 - 30 * dpm) + '^GB' + Math.round(W - 10 * dpm) + ',' + Math.round(60 * dpm) + ',' + Math.round(0.7 * dpm) + '^FS',
    '^FO' + Math.round(8 * dpm) + ',' + Math.round(H / 2 - 24 * dpm) + '^A0N,' + Math.round(7 * dpm) + ',' + Math.round(7 * dpm) + '^FB' + Math.round(W - 16 * dpm) + ',6,' + Math.round(1.5 * dpm) + ',C^FD' + clean(SMALL_QTY_STATEMENT) + '^FS'];
  if (orderCode) out.push('^FO' + Math.round(4 * dpm) + ',' + Math.round(H - 18 * dpm) + '^A0N,' + Math.round(5 * dpm) + ',' + Math.round(5 * dpm) + '^FB' + Math.round(W - 8 * dpm) + ',2,' + Math.round(dpm) + ',C^FD' + clean(orderCode) + '^FS');
  out.push('^XZ');
  const both = zpl.replace(/\s+$/, '') + '\n' + out.join('\n') + '\n';
  return plain ? both : Buffer.from(both).toString('base64');
}

function lqMarkZpl(zplBase64, caption) {
  const zpl = Buffer.from(zplBase64, 'base64').toString('utf8');
  if (!zpl.includes('^XA')) throw new Error('label is not ZPL text');
  // Match the printer resolution of UniUni's own label: ^PW is its width in dots.
  const pw  = parseInt((zpl.match(/\^PW(\d+)/) || [])[1], 10) || 812;
  const dpm = pw / 101.6;                  // dots per mm on a 4-inch-wide label
  const W = pw, H = Math.round(pw * 1.5);
  const g = lqGeometry(W, H, 6 * dpm, 2 * dpm);
  const step = 3;                          // strip height in dots
  const bar  = Math.round(g.t * Math.SQRT2);
  const out  = ['^XA', '^PW' + W, '^LL' + H, '^LH0,0'];
  const box  = (x, y, w) => out.push('^FO' + Math.round(x) + ',' + Math.round(y) + '^GB' + Math.max(Math.round(w), 1) + ',' + step + ',' + step + '^FS');
  for (let y = g.cy - g.r; y < g.cy + g.r; y += step) {
    const hw = g.r - Math.abs(y + step / 2 - g.cy);   // half-width of the diamond on this row
    if (hw <= 0) continue;
    if (Math.abs(y + step / 2 - g.cy) >= g.a || hw * 2 <= bar * 2) {
      box(g.cx - hw, y, hw * 2);                       // black corner: full width
    } else {
      box(g.cx - hw, y, bar);                          // white band: just the two borders
      box(g.cx + hw - bar, y, bar);
    }
  }
  // ^FB wraps inside the label width; \& starts each caption line on its own row.
  const text = caption.map(l => l.replace(/[\^~\\]/g, ' ')).join('\\&');
  const lines = caption.length + 1;        // room for one extra wrap of a long order code
  out.push('^FO' + Math.round(4 * dpm) + ',' + Math.round(H - (6 + 6 * lines) * dpm) + '^A0N,' + Math.round(5 * dpm) + ',' + Math.round(5 * dpm) + '^FB' + Math.round(W - 8 * dpm) + ',' + lines + ',' + Math.round(dpm) + ',C^FD' + text + '^FS', '^XZ');
  return Buffer.from(zpl.replace(/\s+$/, '') + '\n' + out.join('\n') + '\n').toString('base64');
}

// Shipping label + the order's hazmat mark (Limited Quantity diamond, or the
// 173.4 statement for Small Quantity), same format as the label came in.
function withLimitedQuantityMark(labelBase64, format, order, mark) {
  const code = order.shipmentOrderCode || '';
  if (mark === 'SQ') return format === 'zpl' ? sqMarkZpl(labelBase64, code) : sqMarkPdf(labelBase64, code);
  // Two lines, so a long order code never runs off the edge of the label.
  const caption = ['LIMITED QUANTITY', code].filter(Boolean);
  return format === 'zpl' ? lqMarkZpl(labelBase64, caption) : lqMarkPdf(labelBase64, caption);
}

// ─── RATE LOOKUP HELPER ───────────────────────────────────────────────────────

async function getRateAmount(token, shipFromPostal, shipToPostal, weightLB, dims) {
  const l = parseFloat(dims.Length || dims.length || 0);
  const w = parseFloat(dims.Width  || dims.width  || 0);
  const h = parseFloat(dims.Height || dims.height || 0);

  const rateReq = {
    customer_no:       parseInt(UNIUNI_CUSTOMER_NO, 10),
    pickup_warehouse:  parseInt(UNIUNI_WAREHOUSE_ID, 10),
    start_postal_code: shipFromPostal || DEFAULT_FROM.postalCode,
    postal_code:       shipToPostal,
    weight:            weightLB,
    weight_uom:        'LBS',
    length:            l || 13,
    width:             w || 10,
    height:            h || 2,
    dimension_uom:     'IN',
  };

  try {
    const rateRes = await axios.post(
      UNIUNI_BASE_URL + '/orders/estimateshipping',
      rateReq,
      { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }
    );
    const d = rateRes.data;
    if (d.status === 'SUCCESS' && d.data) {
      const cost = parseFloat(d.data.totalAfterTax || d.data.shippingCharge || 0);
      console.log('[RATE-LOOKUP] cost=$' + cost + ' zone=' + d.data.zone);
      return cost;
    }
    return 0;
  } catch (e) {
    console.warn('[RATE-LOOKUP] Failed, defaulting to 0:', e.message);
    return 0;
  }
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.json({
  status: 'running',
  service: 'UniUni <-> Logiwa Middleware',
  version: '1.1.0',
  warehouse_id: UNIUNI_WAREHOUSE_ID || 'NOT SET',
}));

// ─── LABEL PROXY ──────────────────────────────────────────────────────────────

app.get('/label/:id', (req, res) => {
  const cached = labelCache[req.params.id];
  if (!cached) {
    console.log('[LABEL-PROXY] Miss for id=' + req.params.id);
    return res.status(404).json({ error: 'Label not found', id: req.params.id });
  }
  const buf = Buffer.from(cached.labelData, 'base64');
  console.log('[LABEL-PROXY] Serving label id=' + req.params.id + ' format=' + cached.format + ' size=' + buf.length + ' bytes');
  res.setHeader('Content-Type', cached.mimeType || 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="' + req.params.id + '.' + (cached.format || 'pdf') + '"');
  res.send(buf);
});

// ─── LABEL REPRINT (PDF) ──────────────────────────────────────────────────────
// Re-fetches a 4x6 PDF straight from UniUni for an existing tracking number.

app.get('/reprint/:tno', async (req, res) => {
  const tno = req.params.tno;
  if (!/^UUS[A-Z0-9]{10,30}$/.test(tno)) return res.status(400).json({ error: 'Invalid tracking number' });
  console.log('[REPRINT] PDF requested for tno=' + tno);
  try {
    const token = await getUniUniToken();
    const labelRes = await axios.post(
      UNIUNI_BASE_URL + '/orders/printlabel',
      { packageId: tno, labelType: 6, labelFormat: 'pdf', type: 'pdf' },
      {
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        responseType: 'arraybuffer',
      }
    );
    const buf = Buffer.from(labelRes.data);
    console.log('[REPRINT] tno=' + tno + ' size=' + buf.length + ' bytes');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + tno + '.pdf"');
    res.send(buf);
  } catch (e) {
    logError('REPRINT', e);
    res.status(502).json({ error: 'UniUni reprint failed', message: e.message });
  }
});

// ─── 1. GET RATE ──────────────────────────────────────────────────────────────

app.post('/get-rate', async (req, res) => {
  const orders = parseLogiwaBody(req.body);
  console.log('\n[GET-RATE] ══ Incoming Logiwa request ══ orders=' + orders.length + ' first=' + orders[0]?.shipmentOrderCode + ' to=' + (orders[0]?.shipTo?.address?.PostalCode || orders[0]?.shipTo?.address?.postalCode || '?'));

  try {
    const token = await getUniUniToken();
    const out   = [];

    for (const order of orders) {
      const hazmat = hazmatSkus(order);
      console.log('[GET-RATE] ' + order.shipmentOrderCode + ' products=' + orderProducts(order).length + ' hazmat=' + (hazmat.length ? hazmat.join(',') : 'no'));
      const refusal = hazmatRefusal(order);
      if (refusal) {
        console.log('[GET-RATE] BLOCKED ' + order.shipmentOrderCode + ' — ' + refusal);
        out.push({
          shipmentOrderCode:       order.shipmentOrderCode,
          shipmentOrderIdentifier: order.shipmentOrderIdentifier,
          rateList:     [],
          isSuccessful: false,
          message:      [refusal],
        });
        continue;
      }

      const pkg      = order.requestedPackageLineItems?.[0] || {};
      const shipTo   = getAddr(order.shipTo);
      const shipFrom = getAddr(order.shipFrom);
      const weightLB = weightToLB(pkg.weight?.Value || pkg.weight?.value, pkg.weight?.Units || pkg.weight?.units);
      const dims     = pkg.dimensions || {};
      const l = parseFloat(dims.Length || dims.length || 0);
      const w = parseFloat(dims.Width  || dims.width  || 0);
      const h = parseFloat(dims.Height || dims.height || 0);

      const rateReq = {
        customer_no:       parseInt(UNIUNI_CUSTOMER_NO, 10),
        pickup_warehouse:  parseInt(UNIUNI_WAREHOUSE_ID, 10),
        start_postal_code: shipFrom.postalCode || DEFAULT_FROM.postalCode,
        postal_code:       shipTo.postalCode,
        weight:            weightLB,
        weight_uom:        'LBS',
        length:            l || 13,
        width:             w || 10,
        height:            h || 2,
        dimension_uom:     'IN',
      };

      logRequest('GET-RATE', 'POST', UNIUNI_BASE_URL + '/orders/estimateshipping', rateReq);

      let rateList = [], msg = '';
      try {
        const rateRes = await axios.post(
          UNIUNI_BASE_URL + '/orders/estimateshipping',
          rateReq,
          { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }
        );
        logResponse('GET-RATE', rateRes.status, rateRes.data);

        const d = rateRes.data;
        if (d.status === 'SUCCESS' && d.data) {
          const cost = parseFloat(d.data.totalAfterTax || d.data.shippingCharge || 0);
          const eta  = parseInt(d.data.eta, 10) || null;
          rateList = [{
            carrier:        order.carrier || 'Uni Uni',
            shippingOption: 'STANDARD',
            totalCost:      cost,
            shippingCost:   cost,
            otherCost:      0,
            currency:       d.data.currency || 'USD',
            estimatedDays:  eta,
          }];
          console.log('[GET-RATE] Rate: $' + cost + ' zone=' + d.data.zone + ' eta=' + eta + ' days');
        } else {
          msg = d.ret_msg || 'No rate available';
        }
        console.log('[GET-RATE] OK ' + order.shipmentOrderCode + ' - ' + rateList.length + ' rates');
      } catch (e) {
        logError('GET-RATE', e);
        msg = 'UniUni error: ' + (e.response?.data?.ret_msg || e.message);
      }

      out.push({
        shipmentOrderCode:       order.shipmentOrderCode,
        shipmentOrderIdentifier: order.shipmentOrderIdentifier,
        rateList,
        isSuccessful: rateList.length > 0,
        message:      msg ? [msg] : [],
      });
    }

    const logiwaResponse = { data: [out[0]] };
    console.log('[GET-RATE] → Response to Logiwa: ' + (out[0]?.rateList?.length || 0) + ' rates for ' + out[0]?.shipmentOrderCode);
    return res.json(logiwaResponse);

  } catch (err) {
    console.error('[GET-RATE] Fatal:', err.message);
    return res.json({
      data: parseLogiwaBody(req.body).map(o => ({
        shipmentOrderCode:       o.shipmentOrderCode,
        shipmentOrderIdentifier: o.shipmentOrderIdentifier,
        rateList:     [],
        isSuccessful: false,
        message:      ['Middleware error: ' + err.message],
      })),
    });
  }
});

// ─── 2. CREATE LABEL ──────────────────────────────────────────────────────────

app.post('/create-label', async (req, res) => {
  const orders = parseLogiwaBody(req.body);
  console.log('\n[CREATE-LABEL] ══ Incoming Logiwa request ══ orders=' + orders.length + ' first=' + orders[0]?.shipmentOrderCode + ' carrier=' + orders[0]?.carrier + ' service=' + orders[0]?.shippingOption);

  try {
    const token = await getUniUniToken();
    const out   = [];

    for (const order of orders) {
      // Never buy a label for hazmat UniUni does not carry, even if Logiwa was pointed here by hand.
      const hazmat = hazmatSkus(order);
      const refusal = hazmatRefusal(order);
      if (hazmat.length && !refusal) console.log('[CREATE-LABEL] ' + order.shipmentOrderCode + ' hazmat=' + hazmat.join(',') + ' — accepted');
      if (refusal) {
        console.log('[CREATE-LABEL] BLOCKED ' + order.shipmentOrderCode + ' — ' + refusal);
        out.push({
          shipmentOrderIdentifier: order.shipmentOrderIdentifier,
          shipmentOrderCode:       order.shipmentOrderCode,
          carrier:        order.carrier || 'Uni Uni',
          shippingOption: order.shippingOption || 'STANDARD',
          packageResponse:      [],
          rateDetail:           { totalCost: 0, shippingCost: 0, otherCost: 0, currency: 'USD' },
          masterTrackingNumber: '',
          isSuccessful: false,
          message:      [refusal],
        });
        continue;
      }

      const pkg       = order.requestedPackageLineItems?.[0] || {};
      const shipTo    = getAddr(order.shipTo);
      const toContact = getContact(order.shipTo);
      const shipFrom  = getAddr(order.shipFrom);
      const weightLB  = weightToLB(pkg.weight?.Value || pkg.weight?.value, pkg.weight?.Units || pkg.weight?.units);
      const dims      = pkg.dimensions || {};
      const l = parseFloat(dims.Length || dims.length || 13);
      const w = parseFloat(dims.Width  || dims.width  || 10);
      const h = parseFloat(dims.Height || dims.height || 2);

      // Resolve label format from Logiwa labelSpecification — PDF or ZPL
      const labelFmt = resolveLabelFormat(order);
      console.log('[CREATE-LABEL] Label format resolved: ' + labelFmt.format.toUpperCase() + ' (labelType=' + labelFmt.labelType + ')');

      // Rate lookup for postage cost display in Logiwa UI
      const postageAmount = await getRateAmount(
        token,
        shipFrom.postalCode || DEFAULT_FROM.postalCode,
        shipTo.postalCode,
        weightLB,
        dims
      );
      const rateCurrency = order.currency || 'USD';
      console.log('[CREATE-LABEL] Postage cost: $' + postageAmount);

      // Label reference mapping
      const ref1 = pkg.labelReferences?.reference1 || order.shipmentOrderCode || '';
      const ref2 = pkg.labelReferences?.reference2 || '';

      const shipReq = {
        customer_no:       parseInt(UNIUNI_CUSTOMER_NO, 10),
        trace_no:          '',
        reference:         '',
        pickup_address:    buildFullAddress({
          address1:   shipFrom.address1   || DEFAULT_FROM.address1,
          address2:   shipFrom.address2   || '',
          city:       shipFrom.city       || DEFAULT_FROM.city,
          state:      shipFrom.state      || DEFAULT_FROM.state,
          postalCode: shipFrom.postalCode || DEFAULT_FROM.postalCode,
        }),
        delivery_address:  buildFullAddress(shipTo),
        postal_code:       shipTo.postalCode || '',
        receiver:          toContact.name  || '',
        receiver_phone:    toContact.phone || '',
        // No customer email: UniUni sends its own tracking emails to it, and the
        // brand's store is the one that should talk to the customer.
        receiver_email:    '',
        delivery_unit_no:  shipTo.address2 || '',
        length:            l,
        width:             w,
        height:            h,
        weight:            weightLB,
        weight_uom:        'LBS',
        dimension_uom:     'IN',
        require_signature: false,
        custom_field: {
          'LBL-Ref1': ref1,
          'LBL-Ref2': ref2,
        },
      };

      logRequest('CREATE-LABEL', 'POST', UNIUNI_BASE_URL + '/orders/createbusinessorder', shipReq);

      try {
        const shipRes = await axios.post(
          UNIUNI_BASE_URL + '/orders/createbusinessorder',
          shipReq,
          { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }
        );
        logResponse('CREATE-LABEL', shipRes.status, shipRes.data);

        const d = shipRes.data;
        if (d.status !== 'SUCCESS') throw new Error(d.ret_msg || 'UniUni order creation failed');

        const tno      = d.data.tno;
        const order_id = d.data.order_id;
        console.log('[CREATE-LABEL] Order created → tno=' + tno + ' order_id=' + order_id);

        // Print label — format and response type driven by Logiwa labelSpecification
        const labelReq = {
          packageId:   tno,
          labelType:   labelFmt.labelType,
          labelFormat: labelFmt.format,
          type:        labelFmt.type,
        };
        logRequest('CREATE-LABEL:PRINT', 'POST', UNIUNI_BASE_URL + '/orders/printlabel', labelReq);

        const labelRes = await axios.post(
          UNIUNI_BASE_URL + '/orders/printlabel',
          labelReq,
          {
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            responseType: labelFmt.responseType,
          }
        );
        console.log('[CREATE-LABEL:PRINT] Label fetched → format=' + labelFmt.format + ' size=' + (labelRes.data?.byteLength || JSON.stringify(labelRes.data).length) + ' bytes');

        // Extract base64 label data — PDF comes back as arraybuffer, ZPL as JSON with base64
        let labelBase64;
        if (labelFmt.format === 'zpl') {
          // UniUni returns ZPL wrapped in JSON — try common response shapes
          const zplRaw = labelRes.data?.data?.label
            || labelRes.data?.label
            || labelRes.data?.data
            || '';
          labelBase64 = typeof zplRaw === 'string'
            ? zplRaw  // already base64
            : Buffer.from(JSON.stringify(zplRaw)).toString('base64');
          console.log('[CREATE-LABEL:PRINT] ZPL base64 length=' + labelBase64.length);
          if (!labelBase64) {
            const shape = labelRes.data && typeof labelRes.data === 'object'
              ? Object.entries(labelRes.data).map(([k, v]) => k + ':' + (v && typeof v === 'object' ? '{' + Object.keys(v).join(',') + '}' : typeof v)).join(' ')
              : typeof labelRes.data;
            console.warn('[CREATE-LABEL:PRINT] Empty ZPL — response shape: ' + shape);
          }
        } else {
          labelBase64 = Buffer.from(labelRes.data).toString('base64');
        }

        // Hazmat: print the box mark as a second label after this one.
        // The shipping label is already bought, so a failure here must not lose it.
        const mark = labelBase64 && hazmatMarkFor(order);
        if (mark) {
          const name = mark === 'SQ' ? 'Small Quantity (49 CFR 173.4) statement' : 'Limited Quantity mark';
          try {
            labelBase64 = await withLimitedQuantityMark(labelBase64, labelFmt.format, order, mark);
            console.log('[CREATE-LABEL] ' + name + ' added after the shipping label (' + labelFmt.format + ')');
          } catch (e) {
            console.warn('[CREATE-LABEL] ⚠ could not add the ' + name + ' — apply one by hand: ' + e.message);
          }
        }

        labelCache[tno] = {
          labelData: labelBase64,
          format:    labelFmt.format,
          mimeType:  labelFmt.mimeType,
          order_id,
        };
        console.log('[CREATE-LABEL] Label cached → key=' + tno + ' format=' + labelFmt.format);

        const proxyLabelUrl = MIDDLEWARE_URL + '/label/' + tno;
        console.log('[CREATE-LABEL] SUCCESS tracking=' + tno + ' cost=$' + postageAmount + ' format=' + labelFmt.format + ' labelUrl=' + proxyLabelUrl);

        out.push({
          shipmentOrderIdentifier: order.shipmentOrderIdentifier,
          shipmentOrderCode:       order.shipmentOrderCode,
          carrier:        order.carrier || 'Uni Uni',
          shippingOption: order.shippingOption || 'STANDARD',
          packageResponse: [{
            packageSequenceNumber: pkg.packageSequenceNumber || 0,
            trackingNumber:        tno,
            encodedLabel:          labelBase64,
            labelURL:              proxyLabelUrl,
            trackingUrl:           null,
            rateDetail: {
              totalCost:    postageAmount,
              shippingCost: postageAmount,
              otherCost:    0,
              currency:     rateCurrency,
            },
            externalReference: String(order_id),
          }],
          rateDetail: {
            totalCost:    postageAmount,
            shippingCost: postageAmount,
            otherCost:    0,
            currency:     rateCurrency,
          },
          masterTrackingNumber: tno,
          isSuccessful: true,
          message:      [],
        });

      } catch (e) {
        logError('CREATE-LABEL', e);
        const em = e.response?.data?.ret_msg || e.message;
        out.push({
          shipmentOrderIdentifier: order.shipmentOrderIdentifier,
          shipmentOrderCode:       order.shipmentOrderCode,
          carrier:        order.carrier || 'Uni Uni',
          shippingOption: order.shippingOption || 'STANDARD',
          packageResponse:      [],
          rateDetail:           { totalCost: 0, shippingCost: 0, otherCost: 0, currency: 'USD' },
          masterTrackingNumber: '',
          isSuccessful: false,
          message:      ['UniUni error: ' + em],
        });
      }
    }

    const logiwaResponse = { data: [out[0]] };
    console.log('[CREATE-LABEL] → Response to Logiwa: tracking=' + out[0]?.masterTrackingNumber + ' success=' + out[0]?.isSuccessful);
    return res.json(logiwaResponse);

  } catch (err) {
    console.error('[CREATE-LABEL] Fatal:', err.message);
    const o = parseLogiwaBody(req.body)[0] || {};
    return res.json({
      data: [{
        shipmentOrderIdentifier: o.shipmentOrderIdentifier,
        shipmentOrderCode:       o.shipmentOrderCode,
        carrier:        o.carrier || 'Uni Uni',
        shippingOption: o.shippingOption || 'STANDARD',
        packageResponse:      [],
        rateDetail:           { totalCost: 0, shippingCost: 0, otherCost: 0, currency: 'USD' },
        masterTrackingNumber: '',
        isSuccessful: false,
        message:      ['Middleware error: ' + err.message],
      }],
    });
  }
});

// ─── 3. VOID LABEL ────────────────────────────────────────────────────────────

app.post('/void-label', async (req, res) => {
  const orders = parseLogiwaBody(req.body);
  console.log('\n[VOID-LABEL] ══ Incoming Logiwa request ══ trk=' + orders[0]?.masterTrackingNumber);
  try {
    const token = await getUniUniToken();
    const out   = [];

    for (const order of orders) {
      const trk = order.masterTrackingNumber;
      if (!trk) {
        out.push({ shipmentOrderIdentifier: order.shipmentOrderIdentifier, masterTrackingNumber: '', externalReference: '', isSuccessful: false, message: [] });
        continue;
      }

      const cancelReq = { tno: trk };
      logRequest('VOID-LABEL', 'POST', UNIUNI_BASE_URL + '/orders/cancelorder', cancelReq);

      try {
        const cancelRes = await axios.post(
          UNIUNI_BASE_URL + '/orders/cancelorder',
          cancelReq,
          { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }
        );
        logResponse('VOID-LABEL', cancelRes.status, cancelRes.data);

        const d = cancelRes.data;
        const success = d.status === 'SUCCESS' || d.err_code === 0;
        delete labelCache[trk];

        out.push({
          shipmentOrderIdentifier: order.shipmentOrderIdentifier,
          masterTrackingNumber:    order.masterTrackingNumber,
          externalReference:       order.externalReference || trk,
          isSuccessful: success,
          message: [],
        });
      } catch (e) {
        logError('VOID-LABEL', e);
        const alreadyCancelled = e.response?.status === 404 ||
          (e.response?.data?.ret_msg || '').toLowerCase().includes('not found');
        out.push({
          shipmentOrderIdentifier: order.shipmentOrderIdentifier,
          masterTrackingNumber:    order.masterTrackingNumber,
          externalReference:       order.externalReference || trk,
          isSuccessful: alreadyCancelled,
          message: [],
        });
      }
    }
    return res.json({ data: [out[0]] });

  } catch (err) {
    const o = parseLogiwaBody(req.body)[0] || {};
    return res.json({
      data: [{
        shipmentOrderIdentifier: o.shipmentOrderIdentifier,
        masterTrackingNumber:    o.masterTrackingNumber || '',
        externalReference:       '',
        isSuccessful: false,
        message: [],
      }],
    });
  }
});

// ─── 4. END-OF-DAY REPORT ─────────────────────────────────────────────────────

app.post('/end-of-day-report', async (req, res) => {
  const body = Array.isArray(req.body) ? req.body[0] : req.body;
  console.log('\n[EOD] ══ Incoming Logiwa request ══ carrier=' + body?.carrier);
  const stub = {
    closeDate: new Date().toISOString().split('T')[0],
    carrier: 'Uni Uni',
    message: 'UniUni does not require end-of-day manifests',
  };
  return res.json({
    carrierSetupIdentifier: body.carrierSetupIdentifier,
    carrier:       body.carrier || 'Uni Uni',
    encodedReport: Buffer.from(JSON.stringify(stub)).toString('base64'),
    isSuccessful:  true,
    message:       '',
  });
});

app.listen(PORT, () => {
  console.log('\n🚀 UniUni-Logiwa Middleware v1.1.0 on port ' + PORT);
  console.log('   Label proxy  : ' + MIDDLEWARE_URL + '/label/:id');
  console.log('   Customer No  : ' + UNIUNI_CUSTOMER_NO);
  console.log('   Warehouse ID : ' + (UNIUNI_WAREHOUSE_ID || 'NOT SET'));
  console.log('   Base URL     : ' + UNIUNI_BASE_URL + '\n');
});
