const https = require('https');
const http = require('http');

const FEDEX_CLIENT_ID = 'l781069ea65fa949a9a50e3be5fc9a1883';
const FEDEX_CLIENT_SECRET = '8d3f9c8cce9341cf98d87d14d64fc7d7';

function fetchJSON(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(new Error('Invalid JSON response')); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function getToken() {
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
  const token = await getToken();
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

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/track') {
    res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return;
  }

  const tracking = url.searchParams.get('tracking');
  if (!tracking) {
    res.writeHead(400); res.end(JSON.stringify({ error: 'Missing tracking number' })); return;
  }

  try {
    const data = await trackPackage(tracking);
    res.writeHead(200); res.end(JSON.stringify(data));
  } catch(e) {
    res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`FX tracking server running on port ${PORT}`));
