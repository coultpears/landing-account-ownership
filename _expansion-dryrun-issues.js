'use strict';

const fs = require('fs');
const rows = JSON.parse(fs.readFileSync(__dirname + '/_expansion-dryrun-out.json', 'utf8'));

const has = key => rows.filter(r => r.issues.some(i => i.startsWith(key)));

console.log(`\nTotal: ${rows.length} deals\n`);

// --- 56 deals with no company ---
const noCmp = has('NO_COMPANY');
console.log(`==== ${noCmp.length} deals with NO_COMPANY ====`);
const stagesNoCmp = {};
for (const r of noCmp) stagesNoCmp[r.stage || '(blank)'] = (stagesNoCmp[r.stage || '(blank)'] || 0) + 1;
console.log('  by stage:', stagesNoCmp);
console.log('  sample:');
for (const r of noCmp.slice(0, 5)) console.log(`    ${r.dealId}  ${r.dealName}  (current: ${r.currentOwnerName})`);

// --- MULTI_REP ---
const multiRep = has('MULTI_REP');
console.log(`\n==== ${multiRep.length} deals with MULTI_REP (sub-market ambiguity) ====`);
const byCmp = {};
for (const r of multiRep) {
  const k = r.companyName || '(no name)';
  byCmp[k] = byCmp[k] || { reps: r.proposedRepArr, count: 0, hq: r.companyHQ };
  byCmp[k].count++;
}
for (const [name, info] of Object.entries(byCmp).sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${String(info.count).padStart(3)} deals  ${name}  HQ: ${info.hq}  → ${info.reps.join(' OR ')}`);
}

// --- COMPANY_NO_HQ ---
const noHQ = has('COMPANY_NO_HQ');
console.log(`\n==== ${noHQ.length} deals where company is missing HQ ====`);
const cmpNoHQ = {};
for (const r of noHQ) {
  const k = r.companyName || '(no name)';
  cmpNoHQ[k] = (cmpNoHQ[k] || 0) + 1;
}
for (const [name, n] of Object.entries(cmpNoHQ).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)} deals  ${name}`);
}

// --- UNASSIGNED ---
const unassigned = has('UNASSIGNED');
console.log(`\n==== ${unassigned.length} UNASSIGNED ====`);
for (const r of unassigned) {
  console.log(`  ${r.dealId}  ${r.dealName}  cmp: ${r.companyName}  HQ: ${r.companyHQ}`);
}

// --- COMPANY_NO_NAME ---
const cmpNoName = has('COMPANY_NO_NAME');
console.log(`\n==== ${cmpNoName.length} companies with no name ====`);
for (const r of cmpNoName) console.log(`  ${r.dealId}  ${r.dealName}  cmpId: ${r.companyIds[0]}`);

// --- MULTI_COMPANY ---
const multiCmp = has('MULTI_COMPANY');
console.log(`\n==== ${multiCmp.length} deals with multiple companies ====`);
for (const r of multiCmp) console.log(`  ${r.dealId}  ${r.dealName}  cmpIds: ${r.companyIds.join(',')}`);

// --- Top 50 detail ---
const top50 = rows.filter(r => r.rule === 'TOP_50');
console.log(`\n==== ${top50.length} TOP_50 deals (Jack Harvey by Top-50 rule) ====`);
const top50Owners = {};
for (const r of top50) top50Owners[r.matchedOwner] = (top50Owners[r.matchedOwner] || 0) + 1;
for (const [name, n] of Object.entries(top50Owners).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)} deals  → ${name}`);
}

// --- OWNER_ASSIGNMENT detail ---
const ownerAssign = rows.filter(r => r.rule === 'OWNER_ASSIGNMENT');
console.log(`\n==== ${ownerAssign.length} OWNER_ASSIGNMENT deals (existing partner) ====`);
const ownerAssignBy = {};
for (const r of ownerAssign) {
  const k = `${r.matchedOwner} → ${r.proposedRep}`;
  ownerAssignBy[k] = (ownerAssignBy[k] || 0) + 1;
}
for (const [k, n] of Object.entries(ownerAssignBy).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)} deals  ${k}`);
}

// --- Currently has Brady as owner ---
const bradyCurrent = rows.filter(r => r.currentOwnerName === 'Brady Lowery');
console.log(`\n==== ${bradyCurrent.length} deals currently owned by Brady ====`);
const bradyByProposed = {};
for (const r of bradyCurrent) bradyByProposed[r.proposedRep || '(unassigned)'] = (bradyByProposed[r.proposedRep || '(unassigned)'] || 0) + 1;
for (const [name, n] of Object.entries(bradyByProposed).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)} → ${name}`);
}
