const https = require('https');
const http = require('http');

// ── FedEx credentials ─────────────────────────────────
const FEDEX_CLIENT_ID = 'l781069ea65fa949a9a50e3be5fc9a1883';
const FEDEX_CLIENT_SECRET = '8d3f9c8cce9341cf98d87d14d64fc7d7';

// ── Bill.com credentials (from environment variables) ─
const BILL_DEV_KEY = process.env.BILL_DEV_KEY;
const BILL_ORG_ID = process.env.BILL_ORG_ID;
const BILL_USERNAME = process.env.BILL_USERNAME;
const BILL_PASSWORD = process.env.BILL_PASSWORD;

// ── Supabase credentials ──────────────────────────────
const SUPABASE_URL = 'https://rhvmzaljkgqnwjcstnen.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJodm16YWxqa2dxbndqY3N0bmVuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3MTA0OTksImV4cCI6MjA5NzI4NjQ5OX0.3qPGkA9tyvTDWqPQrBjJUnp9_PzNxBJQ-NCv2dUo2DE';

// ── Bill.com session cache ────────────────────────────
let billSession = null;
let billSessionExpiry = null;

// ── Helpers ───────────────────────────────────────────
function fetchJSON(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(new Error('Invalid JSON response: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
  });
}

// ── FedEx ─────────────────────────────────────────────
async function getFedexToken() {
  const body = `grant_type=client_credentials&client_id=${FEDEX_CLIENT_ID}&client_secret=${FEDEX_CLIENT_SECRET}`;
  const result = await fetchJSON({
    hostname: 'apis.fedex.com',
    path: '/oauth/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);
  if (!result.body.access_token) throw new Error('FedEx auth failed: ' + JSON.stringify(result.body));
  return result.body.access_token;
}

async function trackPackage(trackingNumber) {
  const token = await getFedexToken();
  const payload = JSON.stringify({
    includeDetailedScans: false,
    trackingInfo: [{ trackingNumberInfo: { trackingNumber } }]
  });
  const result = await fetchJSON({
    hostname: 'apis.fedex.com',
    path: '/track/v1/trackingnumbers',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'X-locale': 'en_US',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, payload);

  const pkg = result.body?.output?.completeTrackResults?.[0]?.trackResults?.[0];
  if (!pkg) throw new Error('No tracking results found');

  const status = pkg.latestStatusDetail?.description || 'Unknown';
  const statusCode = pkg.latestStatusDetail?.code || '';
  const dateDetails =
    pkg.estimatedDeliveryTimeWindow?.window?.ends ||
    pkg.estimatedDeliveryTimeWindow?.window?.begins ||
    (pkg.dateAndTimes || []).find(d => d.type === 'ESTIMATED_DELIVERY')?.dateTime ||
    (pkg.dateAndTimes || []).find(d => d.type === 'ACTUAL_DELIVERY')?.dateTime || null;

  const deliveryDate = dateDetails ? dateDetails.split('T')[0] : null;
  let appStatus = 'In Transit';
  if (statusCode === 'DL') appStatus = 'Delivered';
  else if (statusCode === 'OD') appStatus = 'Out for Delivery';
  else if (['DY','DE'].includes(statusCode)) appStatus = 'Delayed';

  return { deliveryDate, status, appStatus };
}

// ── Bill.com auth ─────────────────────────────────────
async function getBillSession() {
  // Return cached session if still valid
  if (billSession && billSessionExpiry && Date.now() < billSessionExpiry) {
    return billSession;
  }

  const body = JSON.stringify({
    username: BILL_USERNAME,
    password: BILL_PASSWORD,
    orgId: BILL_ORG_ID,
    devKey: BILL_DEV_KEY,
    applicationKey: BILL_DEV_KEY
  });

  const result = await fetchJSON({
    hostname: 'api.bill.com',
    path: '/api/v2/Login.json',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'devKey': BILL_DEV_KEY
    }
  }, body);

  if (result.body.response_status !== 0) {
    throw new Error('Bill.com auth failed: ' + JSON.stringify(result.body));
  }

  billSession = result.body.response_data.sessionId;
  // Sessions last 35 minutes, refresh after 30
  billSessionExpiry = Date.now() + (30 * 60 * 1000);
  console.log('Bill.com session established');
  return billSession;
}

// ── Supabase: mark invoice as paid ───────────────────
async function markInvoicePaid(invoiceNumber) {
  const url = `${SUPABASE_URL}/rest/v1/outbound_shipments?invoice_number=eq.${encodeURIComponent(invoiceNumber)}&status=eq.Pending`;
  const updateUrl = `${SUPABASE_URL}/rest/v1/outbound_shipments?invoice_number=eq.${encodeURIComponent(invoiceNumber)}&status=eq.Pending`;

  // First check if record exists
  const checkResult = await fetchJSON({
    hostname: 'rhvmzaljkgqnwjcstnen.supabase.co',
    path: `/rest/v1/outbound_shipments?invoice_number=eq.${encodeURIComponent(invoiceNumber)}&status=eq.Pending&select=id,dealer_name`,
    method: 'GET',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  if (!checkResult.body || checkResult.body.length === 0) {
    console.log(`No pending record found for invoice: ${invoiceNumber}`);
    return { updated: false, invoiceNumber };
  }

  const record = checkResult.body[0];
  const patchBody = JSON.stringify({ status: 'Paid' });

  await fetchJSON({
    hostname: 'rhvmzaljkgqnwjcstnen.supabase.co',
    path: `/rest/v1/outbound_shipments?invoice_number=eq.${encodeURIComponent(invoiceNumber)}&status=eq.Pending`,
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
      'Content-Length': Buffer.byteLength(patchBody)
    }
  }, patchBody);

  console.log(`✓ Marked paid: Invoice ${invoiceNumber} — ${record.dealer_name}`);
  return { updated: true, invoiceNumber, dealer: record.dealer_name };
}

// ── HTTP Server ───────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // ── FedEx tracking ──────────────────────────────────
  if (url.pathname === '/track') {
    const tracking = url.searchParams.get('tracking');
    if (!tracking) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing tracking number' })); return; }
    try {
      const data = await trackPackage(tracking);
      res.writeHead(200); res.end(JSON.stringify(data));
    } catch(e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Bill.com webhook ────────────────────────────────
  if (url.pathname === '/bill-webhook' && req.method === 'POST') {
    try {
      const rawBody = await readBody(req);
      console.log('Bill.com webhook received:', rawBody.slice(0, 500));
      
      let payload;
      try { payload = JSON.parse(rawBody); } 
      catch(e) { res.writeHead(200); res.end(JSON.stringify({ ok: true })); return; }

      // Bill.com sends an array of events
      const events = Array.isArray(payload) ? payload : [payload];
      
      for (const event of events) {
        const eventType = event.type || event.eventType || '';
        console.log('Event type:', eventType);

        // Handle invoice paid / payment received events
        if (
          eventType.includes('invoice') ||
          eventType.includes('payment') ||
          eventType.includes('receivedpayment')
        ) {
          let invoiceNumber = null;

          // Parse the payload - Bill.com escapes it as a string
          let innerPayload = event.payload;
          if (typeof innerPayload === 'string') {
            try { innerPayload = JSON.parse(innerPayload); } catch(e) {}
          }

          // Try to find invoice number in various locations
          invoiceNumber = 
            innerPayload?.invoice?.invoiceNumber ||
            innerPayload?.invoiceNumber ||
            innerPayload?.invoice?.number ||
            innerPayload?.receivedPayment?.invoiceNumber ||
            null;

          if (invoiceNumber) {
            const result = await markInvoicePaid(invoiceNumber);
            console.log('Update result:', result);
          }
        }
      }

      // Always respond 200 to Bill.com so they don't retry
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      console.error('Webhook error:', e.message);
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    }
    return;
  }

  // ── Bill.com webhook registration (one-time setup) ──
  if (url.pathname === '/bill-register' && req.method === 'GET') {
    try {
      const sessionId = await getBillSession();
      const subBody = JSON.stringify({
        notificationUrl: 'https://fx-tracking-server.onrender.com/bill-webhook',
        events: [
          { type: 'invoice.updated', version: '1' },
          { type: 'receivedpayment.created', version: '1' },
          { type: 'receivedpayment.updated', version: '1' }
        ]
      });
      const result = await fetchJSON({
        hostname: 'gateway.bill.com',
        path: '/connect/v3/subscriptions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'devKey': BILL_DEV_KEY,
          'sessionId': sessionId,
          'Content-Length': Buffer.byteLength(subBody)
        }
      }, subBody);
      console.log('Bill.com registration result:', JSON.stringify(result.body));
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, result: result.body }));
    } catch(e) {
      console.error('Registration error:', e.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Health check ────────────────────────────────────
  if (url.pathname === '/health') {
    res.writeHead(200); res.end(JSON.stringify({ ok: true, server: 'FX Airguns tracking + Bill.com webhook' }));
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`FX Airguns server running on port ${PORT}`));
