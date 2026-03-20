'use strict';

/**
 * contacts.js — Top 2 contact resolution helper
 *
 * Given a company ID, fetches associated contacts from HubSpot and returns
 * Slack blocks showing the top 2 contacts (sorted by engagement volume).
 */

const {
  getAssociatedIds,
  getPortalId
} = require('../hubspot');

const https = require('https');

function getToken() {
  return process.env.HUBSPOT_TOKEN;
}

function apiRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const token = getToken();
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.hubapi.com',
      path: apiPath,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HubSpot ${res.statusCode} ${method} ${apiPath}`));
        } else {
          try { resolve(JSON.parse(data)); }
          catch { resolve(data); }
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Fetch contacts associated with a company, sorted by engagement (num_notes desc).
 * Returns top N contacts with key properties.
 */
async function getContactsByCompany(companyId, limit = 2) {
  // Get contact IDs associated with this company
  const assocMap = await getAssociatedIds('companies', 'contacts', [String(companyId)]);
  const contactIds = assocMap[String(companyId)] || [];

  if (contactIds.length === 0) return [];

  // Batch-read contact properties
  const props = [
    'firstname', 'lastname', 'jobtitle', 'email', 'phone',
    'num_notes', 'notes_last_contacted'
  ];

  const take = contactIds.slice(0, 20); // fetch up to 20, sort, return top N
  const res = await apiRequest('POST', '/crm/v3/objects/contacts/batch/read', {
    inputs: take.map(id => ({ id: String(id) })),
    properties: props
  });

  const contacts = (res.results || []).map(c => {
    const p = c.properties || {};
    return {
      id: c.id,
      name: [p.firstname, p.lastname].filter(Boolean).join(' ') || '(unnamed)',
      title: p.jobtitle || null,
      email: p.email || null,
      phone: p.phone || null,
      numNotes: parseInt(p.num_notes || '0', 10),
      lastContacted: p.notes_last_contacted || null
    };
  });

  // Sort by engagement volume (num_notes desc)
  contacts.sort((a, b) => b.numNotes - a.numNotes);

  return contacts.slice(0, limit);
}

/**
 * Build Slack blocks for top contacts of a company.
 * Returns an array of blocks (may be empty if no contacts found).
 */
async function buildContactBlocks(companyId) {
  try {
    const contacts = await getContactsByCompany(companyId, 2);
    if (contacts.length === 0) return [];

    const portalId = await getPortalId();
    const lines = contacts.map(c => {
      const link = `https://app.hubspot.com/contacts/${portalId}/contact/${c.id}`;
      const parts = [`<${link}|${c.name}>`];
      if (c.title) parts.push(c.title);
      if (c.email) parts.push(c.email);
      if (c.phone) parts.push(c.phone);
      if (c.lastContacted) {
        const d = new Date(c.lastContacted);
        const days = Math.floor((Date.now() - d.getTime()) / 86400000);
        parts.push(`last contacted ${days}d ago`);
      }
      return '  • ' + parts.join(' · ');
    });

    return [{
      type: 'section',
      text: { type: 'mrkdwn', text: `*Top Contacts:*\n${lines.join('\n')}` }
    }];
  } catch {
    return [];
  }
}

module.exports = { getContactsByCompany, buildContactBlocks };
