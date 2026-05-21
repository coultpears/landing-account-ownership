'use strict';

/**
 * classify-overwrites.js — post-process /tmp/costar-overwrites.json.
 * Splits each rep-value overwrite into:
 *   - cosmetic : values equal after normalization (punctuation/case/abbrev/whitespace)
 *   - material : values genuinely differ — a real data corruption
 *   - rename   : dealname-only rewrites (the canonical-name policy)
 */

const fs = require('fs');

const STATE = { al:'alabama',ak:'alaska',az:'arizona',ar:'arkansas',ca:'california',
  co:'colorado',ct:'connecticut',de:'delaware',fl:'florida',ga:'georgia',hi:'hawaii',
  id:'idaho',il:'illinois',in:'indiana',ia:'iowa',ks:'kansas',ky:'kentucky',la:'louisiana',
  me:'maine',md:'maryland',ma:'massachusetts',mi:'michigan',mn:'minnesota',ms:'mississippi',
  mo:'missouri',mt:'montana',ne:'nebraska',nv:'nevada',nh:'new hampshire',nj:'new jersey',
  nm:'new mexico',ny:'new york',nc:'north carolina',nd:'north dakota',oh:'ohio',ok:'oklahoma',
  or:'oregon',pa:'pennsylvania',ri:'rhode island',sc:'south carolina',sd:'south dakota',
  tn:'tennessee',tx:'texas',ut:'utah',vt:'vermont',va:'virginia',wa:'washington',
  wv:'west virginia',wi:'wisconsin',wy:'wyoming',dc:'washington dc' };

const STREET = [
  [/\bstreet\b/g,'st'],[/\bavenue\b/g,'ave'],[/\bboulevard\b/g,'blvd'],
  [/\bparkway\b/g,'pkwy'],[/\bpky\b/g,'pkwy'],[/\bdrive\b/g,'dr'],[/\broad\b/g,'rd'],
  [/\blane\b/g,'ln'],[/\bcourt\b/g,'ct'],[/\bplace\b/g,'pl'],[/\bterrace\b/g,'ter'],
  [/\bhighway\b/g,'hwy'],[/\bnorth\b/g,'n'],[/\bsouth\b/g,'s'],[/\beast\b/g,'e'],
  [/\bwest\b/g,'w'],[/\bsuite\b/g,'ste'],[/\bapartments?\b/g,'apt']
];

function norm(field, v) {
  let s = String(v == null ? '' : v).toLowerCase().trim();
  s = s.replace(/[.,'"()/#&-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (field === 'property_state') {
    if (STATE[s]) s = STATE[s];
    const inv = Object.entries(STATE).find(([, full]) => full === s);
  }
  if (field === 'property_street_address' || field === 'dealname') {
    for (const [re, rep] of STREET) s = s.replace(re, rep);
    s = s.replace(/\s+/g, ' ').trim();
  }
  if (field === 'company_name') {
    s = s.replace(/\b(inc|llc|llp|lp|ltd|corp|corporation|company|co|group|holdings?|management|partners|realty|capital|properties|trust|development|developments|communities)\b/g, '')
         .replace(/\s+/g, ' ').trim();
  }
  return s;
}

function main() {
  const rep = JSON.parse(fs.readFileSync('/tmp/costar-overwrites.json', 'utf8'));
  const buckets = { material: [], cosmetic: [], rename: [] };
  const materialByField = {};

  for (const o of rep.overwrites) {
    for (const f of o.fields) {
      const entry = { dealId: o.dealId, dealname: o.dealname, owner: o.owner, ...f };
      if (f.field === 'dealname') { buckets.rename.push(entry); continue; }
      const a = norm(f.field, f.repValue);
      const b = norm(f.field, f.ingestValue);
      if (a === b) buckets.cosmetic.push(entry);
      else {
        buckets.material.push(entry);
        materialByField[f.field] = (materialByField[f.field] || 0) + 1;
      }
    }
  }

  // unique deals with >=1 material overwrite
  const materialDeals = [...new Set(buckets.material.map(x => x.dealId))];
  const stillWrong = buckets.material.filter(x => !x.repReverted);

  const out = {
    generatedAt: new Date().toISOString(),
    summary: {
      total_overwrite_findings: buckets.material.length + buckets.cosmetic.length + buckets.rename.length,
      material: buckets.material.length,
      material_unique_deals: materialDeals.length,
      material_still_wrong_now: stillWrong.length,
      cosmetic: buckets.cosmetic.length,
      dealname_rewrites: buckets.rename.length,
      material_by_field: materialByField
    },
    material: buckets.material.sort((a, b) => (a.repReverted?1:0) - (b.repReverted?1:0))
  };
  fs.writeFileSync('/tmp/costar-overwrites-classified.json', JSON.stringify(out, null, 2));

  console.log('=== Overwrite classification ===');
  console.log(`Total overwrite findings : ${out.summary.total_overwrite_findings}`);
  console.log(`  MATERIAL (real corruption)        : ${out.summary.material}  across ${materialDeals.length} deals`);
  console.log(`    still wrong right now           : ${out.summary.material_still_wrong_now}`);
  console.log(`    by field                        : ${JSON.stringify(materialByField)}`);
  console.log(`  cosmetic (punct/case/abbrev)      : ${out.summary.cosmetic}`);
  console.log(`  dealname canonical rewrites       : ${out.summary.dealname_rewrites}`);
  console.log('\n--- MATERIAL overwrites (real data corruption) ---');
  for (const m of buckets.material) {
    const rev = m.repReverted ? '(rep re-fixed)' : '*** STILL WRONG ***';
    console.log(`• ${m.dealId} "${m.dealname}" [${m.owner}]`);
    console.log(`    ${m.field}: rep="${m.repValue}" -> ingest="${m.ingestValue}"  ${rev}`);
  }
  console.log('\nFull: /tmp/costar-overwrites-classified.json');
}

main();
