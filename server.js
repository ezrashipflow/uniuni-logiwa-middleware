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
//   - §2.1  prohibited classes and UN numbers (when Logiwa has them)
// A hazmat product with no class / UN number in Logiwa is let through: the
// guide puts classification on the shipper, and we cannot tell from here.

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
// carriage (allowed on conditions). 2.1 is treated as prohibited: the guide
// lists flammable gases as prohibited and aerosols only under 2.2.
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
    const un = String(p.hazmatIdentificationNumber || '').replace(/\D/g, '').padStart(4, '0');
    if (p.hazmatIdentificationNumber && PROHIBITED_UN.includes(un)) return label + 'does not carry UN' + un + ' (' + (p.sku || 'item') + ')';
    const cls = prohibitedClass(p.hazmatClassDivisionNumber);
    if (cls) return label + 'does not carry ' + cls + ' (' + (p.sku || 'item') + ')';
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

function needsLimitedQuantityMark(order) {
  return orderProducts(order).filter(isHazmatLine).some(p =>
    !LITHIUM_UN.includes(String(p.hazmatIdentificationNumber || '').replace(/\D/g, '')));
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
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const size = 14;
  page.drawText(caption, { x: (W - font.widthOfTextAtSize(caption, size)) / 2, y: 7 * mm, size, font, color: rgb(0, 0, 0) });
  return Buffer.from(await doc.save()).toString('base64');
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
  out.push('^FO0,' + Math.round(H - 14 * dpm) + '^A0N,' + Math.round(5 * dpm) + ',' + Math.round(5 * dpm) + '^FB' + W + ',1,0,C^FD' + caption.replace(/[\^~\\]/g, ' ') + '^FS', '^XZ');
  return Buffer.from(zpl.replace(/\s+$/, '') + '\n' + out.join('\n') + '\n').toString('base64');
}

// Shipping label + Limited Quantity mark, same format as the label came in.
function withLimitedQuantityMark(labelBase64, format, order) {
  const caption = 'LIMITED QUANTITY - ' + (order.shipmentOrderCode || '');
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
        receiver_email:    toContact.email || '',
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

        // Hazmat: print the Limited Quantity mark as a second label after this one.
        // The shipping label is already bought, so a failure here must not lose it.
        if (labelBase64 && needsLimitedQuantityMark(order)) {
          try {
            labelBase64 = await withLimitedQuantityMark(labelBase64, labelFmt.format, order);
            console.log('[CREATE-LABEL] Limited Quantity mark added after the shipping label (' + labelFmt.format + ')');
          } catch (e) {
            console.warn('[CREATE-LABEL] ⚠ could not add the Limited Quantity mark — apply one by hand: ' + e.message);
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
