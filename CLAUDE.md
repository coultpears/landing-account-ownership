# landing-account-ownership

Ownership conflict resolution engine + HubSpot audit tool for Class A/B Conventional Multifamily account coverage.

## Purpose

When a new lead comes in, this engine answers: **who owns this account?** It applies a five-tier priority hierarchy to resolve rep assignment, explains the decision, flags conflicts, and writes an audit log of every check.

---

## Project Structure

```
landing-account-ownership/
├── data/
│   ├── owners.json       Top 50 owner list with attributes + aliases
│   ├── assignments.json  Owner-level and state-based regional rep assignments
│   ├── markets.json      Top 20 MSA definitions with keyword lists
│   ├── config.json       Exclusion list + qualifying/non-MF industry lists
│   ├── cache.json        Web-search enrichment cache (auto-maintained)
│   └── log.json          Append-only audit log (resolve() checks + FIX writes)
├── src/
│   ├── engine.js         Core conflict resolution logic
│   ├── qualify.js        Lead qualification gate (Class A/B Conventional MF)
│   ├── search.js         Web enrichment via DuckDuckGo (owner HQ, property class, location)
│   ├── hubspot.js        HubSpot API wrapper (read + PATCH companies, deals, engagements)
│   ├── audit.js          HubSpot conflict detection (audit / audit-all logic)
│   └── cli.js            CLI interface (check, audit, audit-all, fix)
├── server.js             Slack bot (Phase 3) — /check, /audit-me, /fix slash commands
├── Dockerfile            Container image for Cloud Run deployment
├── .env                  Local secrets — HUBSPOT_TOKEN, SLACK_BOT_TOKEN, etc. (not committed)
├── .env.example          Template for .env setup
└── package.json
```

---

## Resolution Hierarchy

Tiers are evaluated in order. **The first match wins.**

| Tier | Rule | Assigned To |
|------|------|-------------|
| 1 | Owner is in the **Top 50** list | Jack Harvey |
| 2 | Property is a **lease-up** AND all three Xander Williams conditions are met (see below) | Xander Williams |
| 3 | Owner has an **owner-level assignment** (explicit partner relationship) | That rep |
| 4 | **State-based regional fallback** based on property market | Regional rep(s) |
| — | No match found | UNASSIGNED |

### Key rules
- **Tier 1 always wins.** Top 50 owners go to Jack Harvey regardless of market, lease-up status, or any other factor.
- **Tier 3 beats Tier 4.** Owner-level assignments cover **all properties for that owner nationwide**, including referrals, regardless of what state or market the property is in.
- **Xander Williams operates at the property level**, not the owner level. He hunts individual lease-up properties — not owner relationships.

---

## Xander Williams Lease-Up Rules (Tier 2)

Xander Williams gets a lease-up property only when **all three conditions are met**:

1. The owner is **not** in the Top 50
2. **No rep already owns** the owner relationship (not in `ownerAssignments`)
3. The property is in a **Top 20 MSA** (defined in `data/markets.json`)

If any condition fails, Tier 2 is skipped and the lead falls through to Tier 3 or 4:
- Condition 1 fails → Tier 1 already caught it (Jack Harvey)
- Condition 2 fails → Tier 3 assigns to the rep who owns that owner relationship
- Condition 3 fails → Tier 4 assigns to the regional state rep, with a warning that the lease-up is outside Top 20 MSAs

### Top 20 MSAs
New York, Los Angeles, Chicago, Dallas-Fort Worth, Houston, Miami-Fort Lauderdale, Washington DC, Atlanta, Philadelphia, Phoenix, Boston, Riverside-San Bernardino, San Francisco, Detroit, Seattle, Minneapolis-St. Paul, Tampa, San Diego, Denver, Orlando

MSA matching uses **whole-word token matching** against keyword lists in `data/markets.json`. Short single-letter abbreviations are excluded to prevent false matches (e.g. "LA" would match inside "Dallas").

---

## Rep Roster & Assignments

### Enterprise Rep
| Rep | Scope |
|-----|-------|
| **Jack Harvey** | All Top 50 owners + existing enterprise partner relationships |

### Owner-Level Assignments (existing partners — all Jack Harvey)
These override state/market for every property that owner has, anywhere in the country:
- Greystar
- Morgan Properties
- Cortland
- Case & Associates
- RPM (RPM Living)
- American Landmark

### Regional Reps — State Assignments

| Rep | States | Sub-market Focus |
|-----|--------|-----------------|
| **Jack Thomasson** | TN, GA, KY | — |
| **Wells Davis** | TX | DFW & Austin |
| **John LaVanway** | TX | Houston & San Antonio |
| **Scout Bishop** | FL | All of Florida (general) |
| **Ashtyn Garner** | FL | Fort Lauderdale focus |
| **Renato Lagomarsino** | FL | Miami focus |
| **Sophia Nadler** | SC, NC | — |
| **Richard Baugh** | IL, MI, WI, IN, OH | — |
| **Raegan Harris** | AL, MS, LA, AR, CA, NM, AZ, NV | — |
| **Ghislain Cossio** | VA, DC, MD, PA, NJ, NY, CT, MA | — |
| **Nolan Moran** | OK, KS, NE, ID, MO, WY, MT, IA, OR, WA, UT, CO, MN | — |

### Texas sub-market logic
TX is split between Wells (DFW/Austin) and John (Houston/San Antonio). The engine matches the market string against sub-market keyword lists. If the city doesn't match either rep's focus area, both are returned with a coordination warning.

### Florida sub-market logic
FL has three reps. Scout covers all of Florida. Ashtyn and Renato cover focus markets within FL:
- "Miami FL" → Scout + Renato
- "Fort Lauderdale FL" → Scout + Ashtyn
- "Tampa FL" → Scout only
- "Orlando FL" → Scout only

---

## Data Files

### `data/owners.json`
All 50 Top 50 owners assigned to **Jack Harvey**. Each entry:
- `name` — canonical name
- `aliases` — abbreviations and alternate names for fuzzy matching (e.g. `"MAA"`, `"CPT"`, `"EQR"`)
- `propertyClasses` — Class A, Class B, or both
- `propertyType` — "Conventional MF"

### `data/assignments.json`
Two sections:
- `ownerAssignments` — named owner-to-rep assignments (enterprise partners)
- `stateAssignments` — array of `{ rep, states[], subMarkets[], focus }` entries

### `data/markets.json`
Top 20 MSA definitions. Each entry has `id`, `name`, `states[]`, and `keywords[]`. Used exclusively for Xander Williams's Tier 2 eligibility check.

### `data/log.json`
Append-only. Every `resolve()` call writes: timestamp, rule triggered, owner query, matched owner, market, lease-up flag, assigned rep, conflict flag, warnings. The `fix` command also appends entries with `rule: "FIX"` containing before/after field values and source note.

### `data/config.json`
Two runtime-editable lists:
- `excludedCompanies` / `excludedDomains` — company names (partial match) and domains to suppress from conflict reports (vendors, tools, internal records)
- `qualifyingIndustries` / `nonMFIndustries` — HubSpot industry values used to assign `● MF`, `● Unverified`, or `● Non-MF` badges to each conflict

### `data/cache.json`
Auto-maintained. Web enrichment results are stored here keyed by normalized query string. On repeat lookups the CLI uses cached values with no web request. Remove entries manually if stale.

---

## Qualification Gate

Before any resolution runs, `qualify.js` checks that the lead is **Class A or B Conventional MF**. Hard disqualifiers:
- Class C or below
- Affordable / LIHTC / Section 8 / HUD / Tax Credit
- Senior, Student, Assisted Living, Memory Care
- Manufactured / Mobile Home / Single Family / BTR

Disqualified leads are rejected before reaching the engine.

---

## Auto-Enrichment (Web Search + Cache)

The CLI automatically fills in missing context before running resolution. Enrichment fires in three scenarios:

1. **Cache hit** — if a previous lookup already discovered this property/owner, the saved data is applied immediately with no web request.
2. **Property name detected** — if the query contains a number or lacks business-entity terms (e.g. `"Axis 201"`, `"One Park"`), the CLI treats it as a property name and searches for the owner, market, HQ, and property class before resolving.
3. **Owner known but no HQ or market provided** — the CLI searches for the owner's headquarters to enable state-based fallback.

### What gets discovered and used
- **Owner name** — replaces the property name query for resolution
- **Market** — enables Xander Williams MSA check and state fallback
- **Owner HQ** — drives Tier 4 regional assignment (owner's state, not property state)
- **Property class** — passed to the qualification gate if the user didn't supply `--class`; "luxury" maps to Class A; affordable/LIHTC signals to disqualify

### Cache (`data/cache.json`)
Every successful enrichment result is saved to `data/cache.json` keyed by the normalized query string. On subsequent checks of the same property or owner, the CLI uses the cached values and skips the web request. The cache is append-only JSON; entries can be removed manually if stale.

### Web search backend
Enrichment uses DuckDuckGo's free JSON API (`src/search.js`) — no API key required. Results are best-effort: well-known properties and large management companies resolve cleanly; very small or obscure owners may not return useful data. The CLI prints what it found and falls back gracefully when enrichment fails.

**In Claude Code sessions:** Claude's built-in `WebSearch` tool is more reliable than DuckDuckGo for specific property lookups. Claude should run a web search first and pass the enriched flags explicitly (e.g. `--hq "Elmsford NY" --market "New Haven CT"`) for the most accurate results. When a user asks to check a property or owner, Claude should auto-enrich via WebSearch before running the CLI — do not ask the user for information that a web search can answer.

```bash
# Property name — CLI auto-searches for owner + location + class, caches result
node src/cli.js check "Axis 201"

# Same query again — served from cache, no web request
node src/cli.js check "Axis 201"

# Owner only — CLI searches for HQ to enable regional fallback, caches HQ
node src/cli.js check "Paredim Partners"

# Fully specified — no web search needed, fastest path
node src/cli.js check "Paredim Partners" --hq "Elmsford NY" --market "New Haven CT"
```

---

## Running

```bash
# Basic owner lookup
node src/cli.js check "Camden"

# With market (enables state fallback)
node src/cli.js check "MAA" --market "Dallas TX"

# Lease-up (triggers Xander Williams eligibility check)
node src/cli.js check "Unknown Owner" --market "Houston TX" --lease-up

# Lease-up outside Top 20 MSA (Xander Williams blocked, routes to regional rep)
node src/cli.js check "Unknown Owner" --market "Bozeman MT" --lease-up

# Owner-level assignment overrides market
node src/cli.js check "Greystar" --market "Miami FL"

# Via npm script
npm run check -- "AvalonBay" --market "Houston TX"

# Disqualified lead
node src/cli.js check "Some Owner" --class "Class C"
```

### CLI Flags (`check` command)

| Flag | Description |
|------|-------------|
| `--market <market>` | Property location, e.g. `"Dallas TX"`, `"Charlotte NC"` |
| `--hq <location>` | Owner HQ state, e.g. `"VA"`, `"Virginia"`, `"McLean VA"` — drives Tier 4 |
| `--lease-up` | Flag the property as a lease-up |
| `--class <class>` | Property class: `"Class A"` or `"Class B"` |
| `--type <type>` | Property type, e.g. `"Conventional MF"` |

---

## Fuzzy Matching

Owner names are matched against canonical names **and all aliases** using a three-pass approach:

1. **Exact match** — 100% confidence
2. **Substring match** (either direction) — 90% confidence
3. **Word-level overlap** — proportional score (0–65%)

Minimum threshold: **40% confidence**. Below threshold = no match, engine continues to next tier.

To add an alias: edit the `aliases` array in `data/owners.json` (Top 50) or `data/assignments.json` (owner assignments).

---

## Extending

### Add a Top 50 owner
Append to `top50` in `data/owners.json`. Set `assignedRep` to `"Jack Harvey"`.

### Add an owner-level assignment (new partner)
Append to `ownerAssignments` in `data/assignments.json` with `owner`, `aliases`, `rep`, and `assignedAt`.

### Add or update a state assignment
Edit `stateAssignments` in `data/assignments.json`. Add `subMarkets[]` to restrict a rep to specific cities within a state.

### Update Xander Williams's rep name
In `src/engine.js`, change the string `'Xander Williams'` in the Tier 2 block.

### Add a Top 20 MSA
Append to `top20MSAs` in `data/markets.json` with `id`, `name`, `states[]`, and `keywords[]`. Use specific city/neighborhood names as keywords — avoid short abbreviations that could match inside other words.

### Suppress a company from conflict reports
Add its name (partial match, case-insensitive) to `excludedCompanies` in `data/config.json`, or its domain to `excludedDomains`.

### Add a qualifying or non-MF industry
Edit `qualifyingIndustries` or `nonMFIndustries` in `data/config.json`. Values must match HubSpot's industry field exactly (check with `node -e "require('./src/hubspot').getCompany('ID').then(c=>console.log(c.properties.industry))"`).

---

## Phase 2A — HubSpot Conflict Detection

### Setup

1. Copy `.env.example` to `.env` and fill in `HUBSPOT_TOKEN` with a private app token.
2. In HubSpot: **Settings → Integrations → Private Apps → Create private app.**
3. Required scopes: `crm.objects.companies.read`, `crm.objects.companies.write` (needed for `fix` command and owner reassignment), `crm.objects.deals.read`, `crm.objects.contacts.read`, `sales-email-read`, `crm.objects.owners.read`, `crm.schemas.companies.read`, `crm.schemas.companies.write` (needed to auto-create the `landing_ownership_rule` custom property), `crm.associations.read`
4. Optionally set `HUBSPOT_PORTAL_ID` to skip one API call on startup.

### Commands

```bash
# Audit one rep — finds all companies they've touched, flags conflicts
node src/cli.js audit "Scout Bishop"
node src/cli.js audit "Wells Davis" --days 30

# Show only companies that look like MF prospects (hide confirmed non-MF)
node src/cli.js audit "Scout Bishop" --qualified-only

# After the audit, batch-fix companies with missing city/state in HubSpot
node src/cli.js audit "Scout Bishop" --fix

# Full team audit
node src/cli.js audit-all
node src/cli.js audit-all --days 60 --qualified-only

# Fix a single company record by HubSpot record ID
node src/cli.js fix 8924545632

# Via npm scripts
npm run audit -- "Scout Bishop"
npm run audit-all
npm run fix -- 8924545632
```

### Audit flags

| Flag | Description |
|------|-------------|
| `--days <n>` | Lookback window for activity (default: 90) |
| `--qualified-only` | Hide companies with a confirmed non-MF industry (e.g. Technology, Healthcare). Unverified industry = still shown with a warning badge. |
| `--fix` | After the audit, interactively fix companies in conflict that have missing city/state data |

### Qualification badges
Each conflict shows one of three industry badges:
- `● MF` (green) — HubSpot industry matches qualifying list (Real Estate, Construction, etc.)
- `● Unverified` (yellow) — industry field is blank in HubSpot; shown even with `--qualified-only`
- `● Non-MF` (red) — industry is clearly not multifamily; hidden by `--qualified-only`

To add/remove qualifying or non-qualifying industries, edit `data/config.json`.

### Recency sorting
Conflicts are sorted most-recent-first based on `hs_timestamp` from HubSpot engagements and `hs_lastmodifieddate` from deals. Each conflict shows a dedicated **Last activity** line (e.g. `3d ago`, `2w ago`) so you can instantly distinguish hot accounts from dormant ones.

### Exclusion list (`data/config.json`)
Companies matching `excludedCompanies` names (partial, case-insensitive) or `excludedDomains` are silently dropped before conflict detection. Edit `data/config.json` to add new entries — no code changes needed. Current defaults include Landing, Zoom, Google, HubSpot, Slack, Microsoft, Salesforce, Calendly, and others.

### Owner reassignment prompt
After each conflict block is displayed, the CLI prompts:

```
Reassign to [Correct Rep] based on [RULE]? Currently: [Wrong Rep]. [y/N]
```

- **Yes** — updates `hubspot_owner_id` to the correct rep's HubSpot ID and writes `landing_ownership_rule` = rule tier (e.g. `STATE_FALLBACK`). Change is logged to `data/log.json` with `action: "accepted"`.
- **No** — writes `landing_ownership_rule` = `EXCEPTION — [RULE] declined by user on [date]`. Logged with `action: "declined"`.

When multiple reps qualify (e.g. TX split), the prompt lists options by number.

Rep → HubSpot owner ID mappings live in `repOwnerIds` in `data/config.json`. To add a new rep: find their owner ID in HubSpot (Settings → Users & Teams → click user, copy ID from URL) and add to `repOwnerIds`.

### Ownership Rule property (`landing_ownership_rule`)
Custom single-line text property on the company object (group: companyinformation). Created automatically the first time `audit` or `audit-all` runs — no manual HubSpot setup needed. Written on every conflict resolution:
- Accepted: the rule tier (`TOP_50`, `OWNER_ASSIGNMENT`, `STATE_FALLBACK`, etc.)
- Declined: `EXCEPTION — [RULE] declined by user on YYYY-MM-DD`

### Fix command
`fix <record-id>` fetches a company from HubSpot, runs a web search for its HQ city/state/address, shows a before/after diff, and writes the correction back to HubSpot on confirmation. Every fix is logged to `data/log.json` with `rule: "FIX"`.

The `--fix` flag on `audit` does the same thing in batch for all conflict companies missing city/state data.

**Note:** DuckDuckGo's API is best-effort. For important records, verify the proposed values before confirming. In Claude Code sessions, Claude's built-in WebSearch produces more reliable results — run a web search first and pass values manually if needed.

### How conflict detection works

1. For the given rep, the engine searches HubSpot for every deal they own and every engagement (call, email, meeting, task) they've logged in the lookback window.
2. Each engagement/deal is mapped to its associated company record(s) via HubSpot's v4 batch associations API.
3. Companies matching the exclusion list in `data/config.json` are dropped.
4. Every remaining company is run through `engine.resolve()` using company name + city/state.
5. **Conflict** = the engine assigns the account to someone other than the audited rep (and result is not UNASSIGNED).
6. Conflicts are sorted by most recent HubSpot activity first. Each conflict block shows last activity + interactive reassignment prompt.

`audit-all` runs all reps sequentially (to stay within HubSpot rate limits), pre-fetches owners and portal ID once, and outputs a combined report grouped by rep — with the reassignment prompt after each conflict.

### Source files

| File | Purpose |
|------|---------|
| `src/hubspot.js` | HubSpot API wrapper (owners, deals, engagements, associations, companies, PATCH, property creation) |
| `src/audit.js` | Audit logic — exclusion, qual status, recency tracking, conflict detection |
| `src/cli.js` | CLI — conflict display, reassignment prompts, ownership rule writes |
| `data/config.json` | Exclusion list, rep owner IDs, qualifying/non-MF industry lists |

### Company-to-market mapping
The audit uses `city` + `state` from the HubSpot company record as the market string passed to `resolve()`. If either field is blank, the market string is missing and Tier 4 state fallback cannot run. Use `audit --fix` or `fix <id>` to correct records with missing location data.

---

## Phase 3 — Slack Bot

### Overview

A lightweight Slack bot (`server.js`) that exposes the ownership engine, audit pipeline, and fix command as Slack slash commands. Built with Slack Bolt (Node.js). Deploys to Cloud Run or any Node host.

### Slash commands

| Command | Description |
|---------|-------------|
| `/check [owner or property name]` | Full ownership resolution: fuzzy match, web enrichment, qualify, resolve. Returns rule, assigned rep, explanation, and HubSpot record link. Flags missing city/state and recommends `/fix`. |
| `/audit-me` | Runs the 90-day conflict audit for the calling user's rep. Returns conflicts sorted by most-recent activity with company name, HubSpot link, correct owner, rule, and days since last activity. |
| `/fix [record ID or company name]` | Looks up the HubSpot record, runs resolution, shows current vs correct owner with an **Approve** and **Decline** button. Approve updates `hubspot_owner_id` + writes `landing_ownership_rule`. Decline writes the EXCEPTION note. |

### Setup

#### 1. Create the Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**.
2. Under **OAuth & Permissions**, add bot token scopes:
   - `commands` — receive slash commands
   - `users:read` — look up caller's real name for `/audit-me`
3. Under **Slash Commands**, create three commands:
   - `/check` → request URL: `https://your-host/slack/events`
   - `/audit-me` → same URL
   - `/fix` → same URL
4. Under **Interactivity & Shortcuts**, enable interactivity. Set the request URL to `https://your-host/slack/events`.
5. Install the app to your workspace. Copy the **Bot User OAuth Token** (`xoxb-…`).
6. Under **Basic Information → App Credentials**, copy the **Signing Secret**.

#### 2. (Optional) Socket Mode for local dev

Socket Mode lets the bot connect without a public URL — ideal during development:
1. Under **Basic Information → App-Level Tokens**, generate a token with scope `connections:write`. Copy the `xapp-…` token.
2. Set `SLACK_APP_TOKEN=xapp-…` in `.env`. The server auto-detects this and uses Socket Mode.

#### 3. Environment variables

Copy `.env.example` to `.env` and fill in:

```
SLACK_BOT_TOKEN=xoxb-…
SLACK_SIGNING_SECRET=…
SLACK_APP_TOKEN=          # optional, Socket Mode only
PORT=3000                 # Cloud Run sets this automatically
```

#### 4. Map Slack users to reps

Open `server.js` and fill in the `SLACK_TO_REP` object:

```js
const SLACK_TO_REP = {
  'U012AB3CD': 'Scout Bishop',    // Slack user ID → rep name
  'U034EF5GH': 'Wells Davis',
  // …
};
```

To find a user's Slack ID: right-click their name → **View Profile** → **⋮** → **Copy member ID**.

#### 5. Install and run

```bash
npm install
node server.js
# or: npm start
```

### Cloud Run deployment

```bash
# One-time: enable APIs
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com

# One-time: create Artifact Registry repo
gcloud artifacts repositories create landing-ownership \
  --repository-format=docker --location=us-central1

# Build and push
export PROJECT_ID=$(gcloud config get-value project)
export IMAGE=us-central1-docker.pkg.dev/$PROJECT_ID/landing-ownership/bot
gcloud builds submit --tag $IMAGE

# Deploy (replace … with real values — do NOT include SLACK_APP_TOKEN)
gcloud run deploy landing-ownership-bot \
  --image $IMAGE \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --min-instances 1 \
  --timeout 300 \
  --no-cpu-throttling \
  --set-env-vars "HUBSPOT_TOKEN=…,HUBSPOT_PORTAL_ID=…,SLACK_BOT_TOKEN=xoxb-…,SLACK_SIGNING_SECRET=…"

# Get the public URL
gcloud run services describe landing-ownership-bot \
  --platform managed --region us-central1 --format 'value(status.url)'
```

After deployment, set `https://<url>/slack/events` as the Request URL for all three slash commands and for Interactivity & Shortcuts in your Slack app settings.

**Notes:**
- Do **not** set `SLACK_APP_TOKEN` on Cloud Run — its presence enables Socket Mode, which won't work.
- Cloud Run injects `PORT` automatically.
- `--min-instances 1` prevents cold starts. `--timeout 300` gives `/audit-me` enough time to complete.
- `data/cache.json` and `data/log.json` are written inside the container and reset on redeployment. Mount Cloud Storage for persistence if needed.

### Source files

| File | Purpose |
|------|---------|
| `server.js` | Slack bot — slash commands, button action handlers, enrichment + resolution glue |
| `src/engine.js` | Resolution engine (shared with CLI) |
| `src/audit.js` | Audit logic (shared with CLI) |
| `src/hubspot.js` | HubSpot API wrapper — now also exports `searchCompanyByName` |
| `Dockerfile` | Container image for Cloud Run |

### Pending fix state

`/fix` stores context in an in-memory `pendingFixes` Map keyed by a unique ID embedded in the button values. Entries expire after 30 minutes. If a user clicks an expired button, the bot asks them to run `/fix` again.

---

## Phase 2 Ideas (remaining)

- Conflict escalation workflow (flag for manager review)
- Confidence threshold tuning per rule tier
- Web UI for checking ownership without CLI
