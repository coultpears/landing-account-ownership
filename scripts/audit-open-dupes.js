'use strict';

/**
 * audit-open-dupes.js — READ-ONLY. For each CoStar-created deal in the window,
 * check whether the SAME company already had another OPEN AP deal for the same
 * property. If so, the ingest created a duplicate instead of updating the
 * existing open deal — a dedup miss.
 *
 * Output: /tmp/costar-open-dupes.json
 */

const fs  = require('fs');
const hsx = require('../src/costar-sync/hs-extra');
const { apiRequest } = hsx;

const AP_PIPELINE_ID = '64402505';
const WINDOW_START = Date.parse(process.argv[2] || '2026-04-25T00:00:00Z');

const CLOSED = new Set(['126194579','1097165102','126194580','closedwon','closedlost']);

// STRICT matcher. Multifamily owners reuse brand names across many buildings
// (AMLI Lenox / AMLI Westside / AMLI Lindbergh) so a shared name token means
// nothing. A genuine duplicate of the SAME building needs either:
//   • the same normalized street address, OR
//   • an identical normalized property name.
const STREET_ABBR = [
  [/\bstreet\b/g,'st'],[/\bavenue\b/g,'ave'],[/\bboulevard\b/g,'blvd'],
  [/\bparkway\b/g,'pkwy'],[/\bpky\b/g,'pkwy'],[/\bdrive\b/g,'dr'],[/\broad\b/g,'rd'],
  [/\blane\b/g,'ln'],[/\bcircle\b/g,'cir'],[/\bplace\b/g,'pl'],[/\bcourt\b/g,'ct'],
  [/\bnorth\b/g,'n'],[/\bsouth\b/g,'s'],[/\beast\b/g,'e'],[/\bwest\b/g,'w']
];
function normStreet(s) {
  let v = String(s||'').toLowerCase().replace(/[.,'"()#]/g,' ').replace(/\s+/g,' ').trim();
  for (const [re,rep] of STREET_ABBR) v = v.replace(re,rep);
  return v.replace(/\s+/g,' ').trim();
}
function normName(s) {
  return String(s||'').toLowerCase().replace(/[.,'"()&\/-]/g,' ')
    .replace(/\bapartments?\b|\bresidences?\b/g,'').replace(/\s+/g,' ').trim();
}
function sameProperty(a, b) {
  const as=normStreet(a.property_street_address), bs=normStreet(b.property_street_address);
  // street must start with a building number to be a reliable key
  if (as && bs && as===bs && /^\d/.test(as) && as.length>=8) return 'street-exact';
  const an=normName(a.property_name), bn=normName(b.property_name);
  if (an && bn && an===bn && an.length>=5) {
    const ac=(a.property_city||'').toLowerCase().trim(), bc=(b.property_city||'').toLowerCase().trim();
    if (!ac || !bc || ac===bc) return 'name-identical:'+an;
  }
  return null;
}

const DEAL_PROPS = ['dealname','dealstage','hubspot_owner_id','createdate','property_name',
  'property_city','property_state','property_street_address','costar_last_synced',
  'costar_market','costar_property_type','asset_class','costar_year_built'];

async function getOwners(){const m={};let a;do{const r=await apiRequest('GET',`/crm/v3/owners${a?`?after=${a}`:''}`);for(const o of r.results||[])m[String(o.id)]=`${o.firstName||''} ${o.lastName||''}`.trim()||String(o.id);a=r.paging?.next?.after;}while(a);return m;}

async function searchCreated(){
  const out=[];let after;
  do{const r=await apiRequest('POST','/crm/v3/objects/deals/search',{
    filterGroups:[{filters:[{propertyName:'pipeline',operator:'EQ',value:AP_PIPELINE_ID},
      {propertyName:'createdate',operator:'GTE',value:String(WINDOW_START)}]}],
    properties:DEAL_PROPS,sorts:[{propertyName:'createdate',direction:'ASCENDING'}],limit:100,after});
    out.push(...(r.results||[]));after=r.paging?.next?.after;}while(after);
  return out;
}
async function companiesForDeal(id){try{const r=await apiRequest('GET',`/crm/v4/objects/deals/${id}/associations/companies?limit=50`);return (r.results||[]).map(x=>String(x.toObjectId));}catch{return[];}}
async function allDealsForCompany(cid){
  const ids=[];let a;
  do{const r=await apiRequest('GET',`/crm/v4/objects/companies/${cid}/associations/deals?limit=500`+(a?`&after=${encodeURIComponent(a)}`:''));
    for(const x of r.results||[])if(x.toObjectId)ids.push(String(x.toObjectId));a=r.paging?.next?.after;}while(a);
  const deals=[];
  for(let i=0;i<ids.length;i+=100){const r=await apiRequest('POST','/crm/v3/objects/deals/batch/read',{inputs:ids.slice(i,i+100).map(id=>({id})),properties:DEAL_PROPS});deals.push(...(r.results||[]));}
  return deals;
}

async function main(){
  const owners=await getOwners();
  const created=(await searchCreated()).filter(d=>{const p=d.properties||{};return !!(p.costar_last_synced||p.costar_market||p.costar_property_type||p.asset_class||p.costar_year_built);});
  console.error(`[open-dupes] CoStar-created: ${created.length}`);
  const createdIds=new Set(created.map(d=>String(d.id)));

  const dealCompany={};const companyIds=new Set();
  for(const d of created){const cs=await companiesForDeal(d.id);dealCompany[d.id]=cs;cs.forEach(c=>companyIds.add(c));}
  const companyDeals={};let n=0;
  for(const cid of companyIds){companyDeals[cid]=await allDealsForCompany(cid);if(++n%100===0)console.error(`[open-dupes] company pull ${n}/${companyIds.size}`);}

  const dupes=[];
  for(const d of created){
    const dp=d.properties||{};
    const row={property_name:dp.property_name,dealname:dp.dealname,property_city:dp.property_city,
      property_state:dp.property_state,property_street_address:dp.property_street_address};
    for(const cid of (dealCompany[d.id]||[])){
      for(const sib of (companyDeals[cid]||[])){
        if(String(sib.id)===String(d.id))continue;
        const sp=sib.properties||{};
        if(CLOSED.has(sp.dealstage))continue;            // open only
        if(createdIds.has(String(sib.id))&&String(sib.id)>String(d.id))continue; // avoid double-count among created pairs
        const basis=sameProperty(row,{property_name:sp.property_name,dealname:sp.dealname,
          property_city:sp.property_city,property_state:sp.property_state,property_street_address:sp.property_street_address});
        if(basis){
          dupes.push({createdDealId:d.id,createdDealname:dp.dealname,
            createdOwner:owners[dp.hubspot_owner_id]||dp.hubspot_owner_id||'(none)',createdAt:dp.createdate,
            companyId:cid,existingOpenDealId:sib.id,existingOpenDealname:sp.dealname,
            existingStage:sp.dealstage,existingOwner:owners[sp.hubspot_owner_id]||sp.hubspot_owner_id||'(none)',
            existingBothCreatedInWindow:createdIds.has(String(sib.id)),basis});
        }
      }
    }
  }
  // dedupe (a created deal may match multiple siblings — keep all but count unique created deals)
  const uniqCreated=[...new Set(dupes.map(x=>x.createdDealId))];

  const report={generatedAt:new Date().toISOString(),windowStart:new Date(WINDOW_START).toISOString(),
    totals:{costar_created:created.length,open_duplicate_pairs:dupes.length,
      created_deals_that_duplicate_an_open_deal:uniqCreated.length},
    open_duplicates:dupes};
  fs.writeFileSync('/tmp/costar-open-dupes.json',JSON.stringify(report,null,2));

  console.log('\n=== Open-deal duplicate audit ===');
  console.log(`CoStar-created deals                         : ${created.length}`);
  console.log(`Created deals duplicating an existing OPEN   : ${uniqCreated.length}`);
  console.log(`Total duplicate pairs                        : ${dupes.length}`);
  console.log('');
  for(const x of dupes.slice(0,60)){
    const both=x.existingBothCreatedInWindow?' [both ingest-created]':'';
    console.log(`• new ${x.createdDealId} "${x.createdDealname}" [${x.createdOwner}]`);
    console.log(`   dup of OPEN ${x.existingOpenDealId} "${x.existingOpenDealname}" [${x.existingOwner}] — ${x.basis}${both}`);
  }
  if(dupes.length>60)console.log(`...and ${dupes.length-60} more`);
  console.log('\nFull report: /tmp/costar-open-dupes.json');
}
main().catch(e=>{console.error('OPEN-DUPE AUDIT FAILED:',e);process.exit(1);});
