'use strict';

/**
 * ensure-lease-up-category.js — one-shot + idempotent
 *
 * Ensures the HubSpot deal property `deal_category` includes a "Lease Up" option.
 * Safe to run repeatedly — if the option already exists, this is a no-op.
 *
 * Usage: node src/costar-sync/ensure-lease-up-category.js
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '..', '..', '.env');
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* no .env is fine */ }
})();

function request(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const token = process.env.HUBSPOT_TOKEN;
    if (!token) return reject(new Error('HUBSPOT_TOKEN not set'));
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.hubapi.com',
      path: apiPath,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`HubSpot ${res.statusCode} ${method} ${apiPath}: ${data.slice(0, 400)}`));
        }
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function ensureLeaseUpCategory() {
  const prop = await request('GET', '/crm/v3/properties/deals/deal_category');
  const existing = (prop.options || []).map(o => o.value.toLowerCase());

  if (existing.includes('lease up') || existing.includes('lease_up') || existing.includes('leaseup')) {
    console.log('[ensure-lease-up] "Lease Up" already exists on deal_category — no-op');
    return { added: false, options: prop.options };
  }

  const newOptions = [
    ...(prop.options || []),
    {
      label: 'Lease Up',
      value: 'Lease Up',
      description: 'Lease-up property deal sourced by Xander via CoStar export',
      displayOrder: (prop.options || []).length,
      hidden: false
    }
  ];

  const updated = await request('PATCH', '/crm/v3/properties/deals/deal_category', {
    options: newOptions
  });

  console.log('[ensure-lease-up] Added "Lease Up" option to deal_category');
  console.log('   Now has options:', updated.options.map(o => o.label).join(', '));
  return { added: true, options: updated.options };
}

if (require.main === module) {
  ensureLeaseUpCategory().catch(err => {
    console.error('FAILED:', err.message);
    process.exit(1);
  });
}

module.exports = { ensureLeaseUpCategory };
