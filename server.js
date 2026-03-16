/**
 * UniUni eCommerce <-> Logiwa Custom Carrier Middleware v1.0.1
 */
const express = require('express');
const axios   = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '10mb' }));

const UNIUNI_CLIENT_ID     = process.env.UNIUNI_CLIENT_ID;
const UNIUNI_CLIENT_SECRET = process.env.UNIUNI_CLIENT_SECRET;
const UNIUNI_CUSTOMER_NO   = process.env.UNIUNI_CUSTOMER_NO;
const PORT = process.env.PORT || 3000;

const UNIUNI_BASE_URL = 'https://prm-api.uniuni.com';

const MIDDLEWARE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
  : (process.env.MIDDLEWARE_URL || 'https://uniuni-logiwa-middleware-production.up.railway.app');

const labelCache = {};
let cachedToken  = null;
let tokenExpiry  = 0;

// ─── LOGGING ──────────────────────────────────────────────────────────────────

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
// FIX: Use form-encoded body (not JSON) per UniUni API docs

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

    logResponse('AUTH', r.status, { access_token: '***REDACTED***', expires_in: r.data.expires_in });
    cachedToken = r.data.access_token;
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

const DEFAULT_FROM = {
  address1: '625 Jersey Ave, Unit 9',
  city: 'New Brunswick', state: 'NJ', postalCode: '08901', country: 'US',
  name: 'ShipFlow', phone: '9085253857', email: 'info@shipflow.co',
};

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.json({
  status: 'running',
  service: 'UniUni <-> Logiwa Middleware',
  version: '1.0.1',
}));

// ─── LABEL PROXY ──────────────────────────────────────────────────────────────

app.get('/label/:id', (req, res) => {
  const cached = labelCache[req.params.id];
  if (!cached) {
    console.log('[LABEL-PROXY] Miss for id=' + req.params.id);
    return res.status(404).json({ error: 'Label not found', id: req.params.id });
  }
  const buf = Buffer.from(cached.labelData, 'base64');
  console.log('[LABEL-PROXY] Serving label id=' + req.params.id + ' size=' + buf.length + ' bytes');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="' + req.params.id + '.pdf"');
  res.send(buf);
});

// ─── 1. GET RATE ──────────────────────────────────────────────────────────────

app.post('/get-rate', async (req, res) => {
  console.log('\n[GET-RATE] ══ Incoming Logiwa request ══');
  console.log('[GET-RATE] Logiwa payload:\n', JSON.stringify(req.body, null, 2));
  try {
    const token  = await getUniUniToken();
    const orders = parseLogiwaBody(req.body);
    const out    = [];

    for (const order of orders) {
      const pkg      = order.requestedPackageLineItems?.[0] || {};
      const shipTo   = getAddr(order.shipTo);
      const weightLB = weightToLB(pkg.weight?.Value || pkg.weight?.value, pkg.weight?.Units || pkg.weight?.units);
      const dims     = pkg.dimensions || {};
      const l = parseFloat(dims.Length || dims.length || 0);
      const w = parseFloat(dims.Width  || dims.width  || 0);
      const h = parseFloat(dims.Height || dims.height || 0);

      const rateReq = {
        customer_no:   parseInt(UNIUNI_CUSTOMER_NO, 10),
        postal_code:   shipTo.postalCode,
        weight:        weightLB,
        weight_uom:    'LBS',
        length:        l || 13,
        width:         w || 10,
        height:        h || 2,
        dimension_uom: 'IN',
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
        if (d.status === 'SUCCESS' && d.data?.freight_fee != null) {
          rateList = [{
            carrier:        order.carrier || 'UNIUNI-REG',
            shippingOption: 'STANDARD',
            totalCost:      parseFloat(d.data.freight_fee || 0),
            shippingCost:   parseFloat(d.data.freight_fee || 0),
            otherCost:      0,
            currency:       'USD',
          }];
        } else {
          msg = d.ret_msg || 'No rate available';
        }
        console.log('[GET-RATE] OK ' + order.shipmentOrderCode + ' - ' + rateList.length + ' rates');
      } catch (e) {
        logError('GET-RATE', e);
        msg = 'UniUni error: ' + (e.response?.data?.ret_msg || e.message);
      }

      // FIX: message must be an array for Logiwa
      out.push({
        shipmentOrderCode:       order.shipmentOrderCode,
        shipmentOrderIdentifier: order.shipmentOrderIdentifier,
        rateList,
        isSuccessful: rateList.length > 0,
        message:      msg ? [msg] : [],
      });
    }

    const logiwaResponse = { data: [out[0]] };
    console.log('[GET-RATE] → Response to Logiwa:\n', JSON.stringify(logiwaResponse, null, 2));
    return res.json(logiwaResponse);

  } catch (err) {
    console.error('[GET-RATE] Fatal:', err.message);
    // FIX: message must be an array for Logiwa
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
  console.log('\n[CREATE-LABEL] ══ Incoming Logiwa request ══');
  console.log('[CREATE-LABEL] Logiwa payload:\n', JSON.stringify(req.body, null, 2));
  try {
    const token  = await getUniUniToken();
    const orders = parseLogiwaBody(req.body);
    const out    = [];

    for (const order of orders) {
      const pkg         = order.requestedPackageLineItems?.[0] || {};
      const shipTo      = getAddr(order.shipTo);
      const toContact   = getContact(order.shipTo);
      const shipFrom    = getAddr(order.shipFrom);
      const weightLB    = weightToLB(pkg.weight?.Value || pkg.weight?.value, pkg.weight?.Units || pkg.weight?.units);
      const dims        = pkg.dimensions || {};
      const l = parseFloat(dims.Length || dims.length || 13);
      const w = parseFloat(dims.Width  || dims.width  || 10);
      const h = parseFloat(dims.Height || dims.height || 2);

      const shipReq = {
        customer_no:       parseInt(UNIUNI_CUSTOMER_NO, 10),
        reference:         order.shipmentOrderCode || '',
        trace_no:          order.shipmentOrderCode || '',
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
        if (d.status !== 'SUCCESS') {
          throw new Error(d.ret_msg || 'UniUni order creation failed');
        }

        const tno      = d.data.tno;
        const order_id = d.data.order_id;
        console.log('[CREATE-LABEL] Order created → tno=' + tno + ' order_id=' + order_id);

        const labelReq = { packageId: tno, labelType: 6, labelFormat: 'pdf', type: 'pdf' };
        logRequest('CREATE-LABEL:PRINT', 'POST', UNIUNI_BASE_URL + '/orders/printlabel', labelReq);

        const labelRes = await axios.post(
          UNIUNI_BASE_URL + '/orders/printlabel',
          labelReq,
          { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, responseType: 'arraybuffer' }
        );
        console.log('[CREATE-LABEL:PRINT] Label fetched → size=' + labelRes.data.byteLength + ' bytes');

        const labelBase64 = Buffer.from(labelRes.data).toString('base64');
        labelCache[tno] = { labelData: labelBase64, format: 'pdf', order_id };
        console.log('[CREATE-LABEL] Label cached → key=' + tno);

        const proxyLabelUrl = MIDDLEWARE_URL + '/label/' + tno;
        console.log('[CREATE-LABEL] SUCCESS tracking=' + tno + ' labelUrl=' + proxyLabelUrl);

        out.push({
          shipmentOrderIdentifier: order.shipmentOrderIdentifier,
          shipmentOrderCode:       order.shipmentOrderCode,
          carrier:        order.carrier || 'UNIUNI-REG',
          shippingOption: order.shippingOption || 'STANDARD',
          packageResponse: [{
            packageSequenceNumber: pkg.packageSequenceNumber || 0,
            trackingNumber:        tno,
            encodedLabel:          labelBase64,
            labelURL:              proxyLabelUrl,
            trackingUrl:           null,
            rateDetail:            { totalCost: 0, shippingCost: 0, otherCost: 0, currency: 'USD' },
            externalReference:     String(order_id),
          }],
          rateDetail:           { totalCost: 0, shippingCost: 0, otherCost: 0, currency: 'USD' },
          masterTrackingNumber: tno,
          isSuccessful: true,
          message:      [],
        });

      } catch (e) {
        logError('CREATE-LABEL', e);
        const em = e.response?.data?.ret_msg || e.message;
        // FIX: message must be an array for Logiwa
        out.push({
          shipmentOrderIdentifier: order.shipmentOrderIdentifier,
          shipmentOrderCode:       order.shipmentOrderCode,
          carrier:        order.carrier || 'UNIUNI-REG',
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
    console.log('[CREATE-LABEL] → Response to Logiwa:\n', JSON.stringify({
      ...logiwaResponse,
      data: logiwaResponse.data?.map(d => ({
        ...d,
        packageResponse: d.packageResponse?.map(p => ({ ...p, encodedLabel: p.encodedLabel ? '[omitted]' : '' })),
      })),
    }, null, 2));
    return res.json(logiwaResponse);

  } catch (err) {
    console.error('[CREATE-LABEL] Fatal:', err.message);
    const o = parseLogiwaBody(req.body)[0] || {};
    // FIX: message must be an array for Logiwa
    return res.json({
      data: [{
        shipmentOrderIdentifier: o.shipmentOrderIdentifier,
        shipmentOrderCode:       o.shipmentOrderCode,
        carrier:        o.carrier || 'UNIUNI-REG',
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
  console.log('\n[VOID-LABEL] ══ Incoming Logiwa request ══');
  console.log('[VOID-LABEL] Payload:\n', JSON.stringify(req.body, null, 2));
  try {
    const token  = await getUniUniToken();
    const orders = parseLogiwaBody(req.body);
    const out    = [];

    for (const order of orders) {
      const trk = order.masterTrackingNumber;
      if (!trk) {
        out.push({
          shipmentOrderIdentifier: order.shipmentOrderIdentifier,
          masterTrackingNumber: '',
          externalReference: '',
          isSuccessful: false,
          message: [],
        });
        continue;
      }

      const cancelReq = { tno: trk };
      logRequest('VOID-LABEL', 'POST', UNIUNI_BASE_URL + '/orders/cancelbytrackingnumber', cancelReq);

      try {
        const cancelRes = await axios.post(
          UNIUNI_BASE_URL + '/orders/cancelbytrackingnumber',
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
  console.log('\n[EOD] ══ Incoming Logiwa request ══');
  console.log('[EOD] Payload:\n', JSON.stringify(req.body, null, 2));
  const body = Array.isArray(req.body) ? req.body[0] : req.body;
  const stub = {
    closeDate: new Date().toISOString().split('T')[0],
    carrier: 'UNIUNI-REG',
    message: 'UniUni does not require end-of-day manifests',
  };
  return res.json({
    carrierSetupIdentifier: body.carrierSetupIdentifier,
    carrier:       body.carrier || 'UNIUNI-REG',
    encodedReport: Buffer.from(JSON.stringify(stub)).toString('base64'),
    isSuccessful:  true,
    message:       '',
  });
});

app.listen(PORT, () => {
  console.log('\n🚀 UniUni-Logiwa Middleware v1.0.1 on port ' + PORT);
  console.log('   Label proxy  : ' + MIDDLEWARE_URL + '/label/:id');
  console.log('   Customer No  : ' + UNIUNI_CUSTOMER_NO);
  console.log('   Base URL     : ' + UNIUNI_BASE_URL + '\n');
});
