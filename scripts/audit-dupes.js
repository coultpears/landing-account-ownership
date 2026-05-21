'use strict';

/**
 * audit-dupes.js — READ-ONLY combined duplicate audit.
 * Pulls every company touched by a CoStar-created deal once (cached to
 * /tmp/costar-company-deals.json), then runs a STRICT same-building matcher to
 * find created deals that duplicate either:
 *   - an existing CLOSED-WON deal  (bug: dedup is blind to closed stages)
 *   - an existing OPEN deal        (bug: dedup missed a live deal)
 *
 * Strict matcher: same normalized street address (with building number) OR
 * identical normalized property name. Brand-token overlap is NOT a match.
 *
 * Usage: node scripts/audit-dupes.js [windowISO] [--refresh]
 * Output: /tmp/costar-dupes.json
 */

const fs  = require('fs');
const hsx = require('../src/costar-sync/hs-extra');

// Resilient wrapper — hs-extra.apiRequest only retries 429. Add 5xx + network
// retry with backoff so a transient HubSpot blip doesn't kill a long run.
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function apiRequest(method, path, body) {
  let lastErr;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return await hsx.apiRequest(method, path, body);
    } catch (e) {
      lastErr = e;
      const sc = e.statusCode;
      const retryable = !sc || sc >= 500 || sc === 429;
      if (!retryable || attempt === 6) throw e;
      await sleep(attempt * 2000);
    }
  }
  throw lastErr;
}

const AP_PIPELINE_ID = '64402505';
const WINDOW_START = Date.parse(process.argv.find(a => /^\d{4}-/.test(a)) || '2026-04-25T00:00:00Z');
const REFRESH = process.argv.includes('--refresh');
const CACHE = '/tmp/costar-company-deals.json';

const STREET_ABBR = [
  [/\bstreet\b/g,'st'],[/\bavenue\b/g,'ave'],[/\bboulevard\b/g,'blvd'],
  [/\bparkway\b/g,'pkwy'],[/\bpky\b/g,'pkwy'],[/\bdrive\b/g,'dr'],[/\broad\b/g,'rd'],
  [/\blane\b/g,'ln'],[/\bcircle\b/g,'cir'],[/\bplace\b/g,'pl'],[/\bcourt\b/g,'ct'],
  [/\bnorth\b/g,'n'],[/\bsouth\b/g,'s'],[/\beast\b/g,'e'],[/\bwest\b/g,'w']
];
function normStreet(s){let v=String(s||'').toLowerCase().replace(/[.,'"()#]/g,' ').replace(/\s+/g,' ').trim();for(const[re,rep]of STREET_ABBR)v=v.replace(re,rep);return v.replace(/\s+/g,' ').trim();}
function normName(s){return String(s||'').toLowerCase().replace(/[.,'"()&\/-]/g,' ').replace(/\bapartments?\b|\bresidences?\b/g,'').replace(/\s+/g,' ').trim();}
function sameProperty(a,b){
  const as=normStreet(a.property_street_address),bs=normStreet(b.property_street_address);
  if(as&&bs&&as===bs&&/^\d/.test(as)&&as.length>=8)return'street-exact';
  const an=normName(a.property_name),bn=normName(b.property_name);
  if(an&&bn&&an===bn&&an.length>=5){
    const ac=(a.property_city||'').toLowerCase().trim(),bc=(b.property_city||'').toLowerCase().trim();
    if(!ac||!bc||ac===bc)return'name-identical:'+an;
  }
  return null;
}

const DEAL_PROPS=['dealname','dealstage','pipeline','hubspot_owner_id','createdate','closedate',
  'property_name','property_city','property_state','property_street_address','company_name',
  'costar_last_synced','costar_market','costar_property_type','asset_class','costar_year_built'];

async function getOwners(){const m={};let a;do{const r=await apiRequest('GET',`/crm/v3/owners${a?`?after=${a}`:''}`);for(const o of r.results||[])m[String(o.id)]=`${o.firstName||''} ${o.lastName||''}`.trim()||String(o.id);a=r.paging?.next?.after;}while(a);return m;}
async function getClosedWonStages(){const ids=new Set(),named={};const pl=await apiRequest('GET','/crm/v3/pipelines/deals');for(const p of pl.results||[])for(const s of p.stages||[])if(Number(s?.metadata?.probability)===1){ids.add(s.id);named[s.id]=`${p.label}/${s.label}`;}return{ids,named};}
async function searchCreated(){const out=[];let after;do{const r=await apiRequest('POST','/crm/v3/objects/deals/search',{filterGroups:[{filters:[{propertyName:'pipeline',operator:'EQ',value:AP_PIPELINE_ID},{propertyName:'createdate',operator:'GTE',value:String(WINDOW_START)}]}],properties:DEAL_PROPS,sorts:[{propertyName:'createdate',direction:'ASCENDING'}],limit:100,after});out.push(...(r.results||[]));after=r.paging?.next?.after;}while(after);return out;}
async function companiesForDeal(id){try{const r=await apiRequest('GET',`/crm/v4/objects/deals/${id}/associations/companies?limit=50`);return(r.results||[]).map(x=>String(x.toObjectId));}catch{return[];}}
async function allDealsForCompany(cid){const ids=[];let a;do{const r=await apiRequest('GET',`/crm/v4/objects/companies/${cid}/associations/deals?limit=500`+(a?`&after=${encodeURIComponent(a)}`:''));for(const x of r.results||[])if(x.toObjectId)ids.push(String(x.toObjectId));a=r.paging?.next?.after;}while(a);if(!ids.length)return[];const deals=[];for(let i=0;i<ids.length;i+=100){const r=await apiRequest('POST','/crm/v3/objects/deals/batch/read',{inputs:ids.slice(i,i+100).map(id=>({id})),properties:DEAL_PROPS});deals.push(...(r.results||[]));}return deals;}

async function main(){
  const owners=await getOwners();
  const {ids:cwStages,named:cwNamed}=await getClosedWonStages();
  const CLOSED_NONWON=new Set(['1097165102','126194580','closedlost']);

  const created=(await searchCreated()).filter(d=>{const p=d.properties||{};return!!(p.costar_last_synced||p.costar_market||p.costar_property_type||p.asset_class||p.costar_year_built);});
  console.error(`[dupes] CoStar-created: ${created.length}`);
  const createdIds=new Set(created.map(d=>String(d.id)));

  // company -> deals (cached + checkpointed; resumes after a crash)
  let dealCompany={},companyDeals={};
  if(fs.existsSync(CACHE)){
    const c=JSON.parse(fs.readFileSync(CACHE,'utf8'));
    dealCompany=c.dealCompany||{};companyDeals=c.companyDeals||{};
    console.error(`[dupes] loaded cache: ${Object.keys(companyDeals).length} companies, ${Object.keys(dealCompany).length} deal->company maps`);
  }
  // resolve deal->company for any created deal not yet mapped
  const needMap=created.filter(d=>!dealCompany[d.id]);
  if(needMap.length){
    console.error(`[dupes] resolving deal->company for ${needMap.length} deals`);
    for(const d of needMap)dealCompany[d.id]=await companiesForDeal(d.id);
    fs.writeFileSync(CACHE,JSON.stringify({dealCompany,companyDeals}));
  }
  // pull deals for any company not yet pulled (checkpoint every 50)
  const companyIds=new Set();
  for(const d of created)for(const c of(dealCompany[d.id]||[]))companyIds.add(c);
  const todo=[...companyIds].filter(c=>!companyDeals[c]);
  if(REFRESH){todo.length=0;for(const c of companyIds)delete companyDeals[c];todo.push(...companyIds);}
  if(todo.length){
    console.error(`[dupes] pulling deals for ${todo.length} companies (${companyIds.size-todo.length} cached)`);
    let n=0;
    for(const cid of todo){
      companyDeals[cid]=await allDealsForCompany(cid);
      if(++n%50===0){fs.writeFileSync(CACHE,JSON.stringify({dealCompany,companyDeals}));console.error(`[dupes] company pull ${n}/${todo.length} (checkpointed)`);}
    }
    fs.writeFileSync(CACHE,JSON.stringify({dealCompany,companyDeals}));
    console.error(`[dupes] company pull complete -> ${CACHE}`);
  }

  const cwDupes=[],openDupes=[];
  for(const d of created){
    const dp=d.properties||{};
    const row={property_name:dp.property_name,dealname:dp.dealname,property_city:dp.property_city,property_state:dp.property_state,property_street_address:dp.property_street_address};
    for(const cid of(dealCompany[d.id]||[])){
      for(const sib of(companyDeals[cid]||[])){
        if(String(sib.id)===String(d.id))continue;
        const sp=sib.properties||{};
        const basis=sameProperty(row,{property_name:sp.property_name,dealname:sp.dealname,property_city:sp.property_city,property_state:sp.property_state,property_street_address:sp.property_street_address});
        if(!basis)continue;
        if(cwStages.has(sp.dealstage)){
          cwDupes.push({newDeal:d.id,newName:dp.dealname,newOwner:owners[dp.hubspot_owner_id]||dp.hubspot_owner_id||'(none)',
            closedWonDeal:sib.id,closedWonName:sp.dealname,closedWonStage:cwNamed[sp.dealstage]||sp.dealstage,
            closedWonOwner:owners[sp.hubspot_owner_id]||sp.hubspot_owner_id||'(none)',closeDate:sp.closedate,basis});
        }else if(!CLOSED_NONWON.has(sp.dealstage)){
          if(createdIds.has(String(sib.id))&&Number(sib.id)<Number(d.id))continue; // count each created-created pair once
          openDupes.push({newDeal:d.id,newName:dp.dealname,newOwner:owners[dp.hubspot_owner_id]||dp.hubspot_owner_id||'(none)',
            openDeal:sib.id,openName:sp.dealname,openOwner:owners[sp.hubspot_owner_id]||sp.hubspot_owner_id||'(none)',
            bothIngestCreated:createdIds.has(String(sib.id)),basis});
        }
      }
    }
  }
  const cwUnique=[...new Set(cwDupes.map(x=>x.newDeal))];
  const openUnique=[...new Set(openDupes.map(x=>x.newDeal))];

  const report={generatedAt:new Date().toISOString(),windowStart:new Date(WINDOW_START).toISOString(),
    matcher:'strict: street-exact (w/ building number) OR identical normalized property name',
    totals:{costar_created:created.length,
      closed_won_duplicate_pairs:cwDupes.length,closed_won_duplicate_deals:cwUnique.length,
      open_duplicate_pairs:openDupes.length,open_duplicate_deals:openUnique.length},
    closed_won_duplicates:cwDupes,open_duplicates:openDupes};
  fs.writeFileSync('/tmp/costar-dupes.json',JSON.stringify(report,null,2));

  console.log('\n=== Strict duplicate audit ===');
  console.log(`CoStar-created deals                       : ${created.length}`);
  console.log(`Duplicates a CLOSED-WON deal               : ${cwUnique.length} deals (${cwDupes.length} pairs)`);
  for(const x of cwDupes) console.log(`  • new ${x.newDeal} "${x.newName}" [${x.newOwner}]\n     = CLOSED-WON ${x.closedWonDeal} "${x.closedWonName}" [${x.closedWonOwner}] (${x.basis})`);
  console.log(`\nDuplicates an existing OPEN deal           : ${openUnique.length} deals (${openDupes.length} pairs)`);
  for(const x of openDupes.slice(0,60)){
    console.log(`  • new ${x.newDeal} "${x.newName}" [${x.newOwner}]\n     = OPEN ${x.openDeal} "${x.openName}" [${x.openOwner}] (${x.basis})${x.bothIngestCreated?' [both ingest-created]':''}`);
  }
  if(openDupes.length>60)console.log(`  ...and ${openDupes.length-60} more`);
  console.log('\nFull report: /tmp/costar-dupes.json');
}
main().catch(e=>{console.error('DUPE AUDIT FAILED:',e);process.exit(1);});
