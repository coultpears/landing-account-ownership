# landing-account-ownership

Phase 1 ownership conflict resolution engine for Class A/B Conventional Multifamily account coverage.

## Purpose

When a new lead comes in, this engine answers: **who owns this account?** It applies a four-tier priority hierarchy to resolve rep assignment, explains the decision, flags conflicts, and writes an audit log of every check.

---

## Project Structure

```
landing-account-ownership/
├── data/
│   ├── owners.json       Top 50 owner list with attributes + aliases
│   ├── assignments.json  Owner-level and market/region rep assignments
│   └── log.json          Append-only audit log of every resolution check
├── src/
│   ├── engine.js         Core conflict resolution logic
│   ├── qualify.js        Lead qualification gate (Class A/B Conventional MF)
│   └── cli.js            CLI interface
└── package.json
```

---

## Resolution Hierarchy

Tiers are evaluated in order. The first match wins.

| Tier | Rule | Assigned To |
|------|------|-------------|
| 1 | Owner is in the **Top 50** list | Jack Thomasson |
| 2 | Property is **lease-up** AND owner is NOT Top 50 | Xavier |
| 3 | Owner has an **owner-level assignment** (explicit partner) | That rep |
| 4 | **Market/region fallback** based on property location | Market rep(s) |
| — | No match found | UNASSIGNED |

**Owner-level assignments always beat market assignments (Tier 3 > Tier 4).**

---

## Data

### Top 50 Owners (`data/owners.json`)

All 50 owners are assigned to **Jack Thomasson**. Each entry has:
- `name` — canonical name
- `aliases` — common abbreviations and alternate names used for fuzzy matching
- `propertyClasses` — Class A, Class B, or both
- `propertyType` — typically "Conventional MF"

### Assignments (`data/assignments.json`)

**Owner-level assignments** (existing partners → all Jack Thomasson):
- Greystar, Morgan Properties, Cortland, Case & Associates, RPM, American Landmark

**Direct market assignments:**
- Miami FL, Fort Lauderdale FL → Ashtyn + Renato
- Dallas TX, Houston TX → John + Wells

**Region assignments:**
- Eastern Seaboard (VA, NC, SC, GA, FL) → G
  - Excludes: Miami FL and Fort Lauderdale FL (covered by Ashtyn + Renato)

### Audit Log (`data/log.json`)

Every call to `resolve()` appends a timestamped entry. Contains: timestamp, rule triggered, owner query, matched owner, market, lease-up flag, assigned rep, and any warnings.

---

## Running

```bash
# Basic owner lookup
node src/cli.js check "Camden"

# With market
node src/cli.js check "MAA" --market "Dallas TX"

# Lease-up flag
node src/cli.js check "Unknown Owner" --market "Charlotte NC" --lease-up

# Owner-level assignment overriding market
node src/cli.js check "Greystar" --market "Miami FL"

# Via npm script
npm run check -- "AvalonBay" --market "Houston TX"

# Disqualification example
node src/cli.js check "Some Owner" --class "Class C"
```

### CLI Options

| Flag | Description |
|------|-------------|
| `--market <market>` | Market name, e.g. `"Dallas TX"`, `"Charlotte NC"` |
| `--lease-up` | Flag the property as a lease-up |
| `--class <class>` | Property class, e.g. `"Class A"` or `"Class B"` |
| `--type <type>` | Property type, e.g. `"Conventional MF"` |

---

## Fuzzy Matching

Owner names are matched against canonical names **and aliases** using:
1. Exact match (100% confidence)
2. Substring match, either direction (90%)
3. Word-level overlap (proportional score)

Minimum threshold: 30% confidence. If below threshold, no match is returned and the engine continues to the next tier.

To add aliases for an owner, edit the `aliases` array in `data/owners.json` or `data/assignments.json`.

---

## Extending

### Add a Top 50 owner
Append to the `top50` array in `data/owners.json`.

### Add an owner-level assignment
Append to `ownerAssignments` in `data/assignments.json`.

### Add a market assignment
Append to `marketAssignments` in `data/assignments.json`.

### Add a region
Append to `regionAssignments` with a `states` array and optional `excludedMarkets`.

### Change the lease-up rep
In `src/engine.js`, update the string `'Xavier'` in the Tier 2 block.

---

## Phase 2 Ideas

- REST API wrapper around `engine.js`
- CRM/Salesforce integration (push resolution results to lead records)
- Conflict escalation workflow (flag for manager review)
- Confidence threshold tuning per rule tier
- Web UI for checking ownership without CLI
