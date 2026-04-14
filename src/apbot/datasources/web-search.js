'use strict';

/**
 * web-search.js — Web search via DuckDuckGo Lite
 *
 * Returns structured search results with titles, snippets, and URLs.
 * DuckDuckGo Lite returns server-rendered HTML with rich snippets including
 * pricing, availability, and property details from listing sites.
 *
 * No API key required. Apartment listing sites (apartments.com, zillow,
 * forrent.com, etc.) show up with pricing and unit data in the snippets.
 */

const https = require('https');

/**
 * Search the web and return structured results.
 * @param {string} query - Search query
 * @param {number} [maxResults=10] - Max results to return
 * @returns {Promise<Array<{title, snippet, url}>>}
 */
async function webSearch(query, maxResults = 10) {
  const encoded = encodeURIComponent(query);
  const url = `https://lite.duckduckgo.com/lite/?q=${encoded}`;

  const html = await httpGet(url);

  // Parse results from DuckDuckGo Lite HTML table rows
  const tds = html.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [];
  const results = [];
  let current = {};

  for (const td of tds) {
    const clean = stripHtml(td);
    if (clean.length < 15) continue;

    // Title row: contains a link and is relatively short
    if (/<a[^>]*href/.test(td) && clean.length < 250) {
      if (current.title && (current.snippet || current.url)) {
        results.push(current);
      }
      // Extract URL — DDG lite wraps URLs in redirect links
      let resultUrl = '';
      const uddgMatch = td.match(/uddg=([^&"]+)/);
      if (uddgMatch) {
        resultUrl = decodeURIComponent(uddgMatch[1]);
      } else {
        const hrefMatch = td.match(/href="([^"]+)"/);
        if (hrefMatch && !hrefMatch[1].includes('duckduckgo.com')) {
          resultUrl = hrefMatch[1];
        }
      }
      current = { title: clean, url: resultUrl, snippet: '' };
    }
    // URL row: just a URL display
    else if (clean.length < 100 && /^(https?:|www\.)/.test(clean.trim())) {
      // Skip URL display rows
    }
    // Snippet row: longer text that's the description
    else if (clean.length > 40 && !/<a/.test(td) && !current.snippet && current.title) {
      current.snippet = clean;
    }
  }
  if (current.title && (current.snippet || current.url)) {
    results.push(current);
  }

  return results.slice(0, maxResults);
}

function stripHtml(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 12000
    };

    https.get(url, options, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode >= 400) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

module.exports = { webSearch };
