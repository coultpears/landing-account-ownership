# Landing Account Ownership

Conflict resolution engine for Landing's sales team. When a new multifamily lead comes in, it answers **who owns this account** — instantly, with an explanation of why.

---

## How it works

Four tiers are evaluated in order. First match wins.

| Priority | Rule | Goes to |
|----------|------|---------|
| 1 | Owner is in the **Top 50** list | Jack Harvey |
| 2 | Property is a **lease-up** AND owner is not Top 50, no rep owns the relationship, and property is in a **Top 20 MSA** | Xavier |
| 3 | Owner has an **existing rep relationship** (signed partner) | That rep — covers all their properties nationwide |
| 4 | No match above — falls back to the **rep covering the owner's HQ state** | Regional rep |

> **Key rule:** Ownership is at the *owner* level, not the property level. A Virginia-based owner with a property in Miami belongs to Ghislain (VA rep), not Scout/Renato (FL reps). Pass `--hq` to tell the engine where the owner is headquartered.

---

## Running a check

```bash
node src/cli.js check "<owner name>" [--hq <state>] [--market <city state>] [--lease-up]
```

Or via npm:

```bash
npm run check -- "<owner name>" [options]
```

### Examples

```bash
# Top 50 owner — always Jack Harvey, market doesn't matter
node src/cli.js check "Camden Property Trust" --market "Dallas TX"

# Lease-up in a Top 20 MSA with no existing relationship — Xavier
node src/cli.js check "Sunrise Apartments LLC" --market "Miami FL" --lease-up

# Owner HQ'd in Virginia with a property in Miami — Ghislain Cossio (VA)
node src/cli.js check "Pinnacle Property Group" --hq "Virginia" --market "Miami FL"

# Existing partner — owner-level assignment wins regardless of market
node src/cli.js check "Cortland" --market "Atlanta GA"

# Lease-up outside Top 20 MSA — Xavier blocked, goes to regional rep
node src/cli.js check "Small Owner LLC" --market "Bozeman MT" --lease-up
```

### Flags

| Flag | What it does |
|------|-------------|
| `--hq <location>` | Owner's HQ state. Accepts `"VA"`, `"Virginia"`, or `"McLean VA"`. Used for Tier 4 regional assignment. |
| `--market <city state>` | Property location, e.g. `"Miami FL"`. Required for Xavier's Top 20 MSA check. |
| `--lease-up` | Flags the property as a lease-up. Triggers Xavier eligibility check. |
| `--class <class>` | Property class (`"Class A"`, `"Class B"`). Disqualifies Class C and below. |
| `--type <type>` | Property type. Disqualifies affordable, LIHTC, senior, student housing, etc. |

Every check is logged automatically to `data/log.json`.

---

## Adding owners and assignments

**Add a Top 50 owner** → `data/owners.json`, append to the `top50` array:
```json
{
  "id": "new-owner-name",
  "name": "New Owner Name",
  "aliases": ["Short Name", "ABBR"],
  "assignedRep": "Jack Harvey",
  "propertyClasses": ["Class A", "Class B"],
  "propertyType": "Conventional MF"
}
```

**Add an owner-level assignment (new signed partner)** → `data/assignments.json`, append to `ownerAssignments`:
```json
{
  "owner": "Partner Name",
  "aliases": ["Alt Name"],
  "rep": "Rep Full Name",
  "assignedAt": "2026-01-01T00:00:00Z",
  "notes": "Signed partner"
}
```

**Update a regional rep's states** → `data/assignments.json`, edit the relevant entry in `stateAssignments`. Add cities to `subMarkets` to restrict a rep to specific markets within a state (used for TX and FL splits).

---

## Rep coverage map

| Rep | Coverage |
|-----|----------|
| Jack Harvey | All Top 50 accounts + existing enterprise partners |
| Jack Thomasson | TN, GA, KY |
| Wells Davis | TX — DFW & Austin |
| John LaVanway | TX — Houston & San Antonio |
| Scout Bishop | FL (all markets) |
| Ashtyn Garner | FL — Fort Lauderdale focus |
| Renato Lagomarsino | FL — Miami focus |
| Sophia Nadler | SC, NC |
| Richard Baugh | IL, MI, WI, IN, OH |
| Raegan Harris | AL, MS, LA, AR, CA, NM, AZ, NV |
| Ghislain Cossio | VA, DC, MD, PA, NJ, NY, CT, MA |
| Nolan Moran | OK, KS, NE, ID, MO, WY, MT, IA, OR, WA, UT, CO, MN |
| Xavier | Lease-up hunting — Top 20 MSAs only |

---

---

## Slack Bot

Three slash commands available in Slack:

| Command | What it does |
|---------|-------------|
| `/check [owner or property name]` | Full ownership resolution — fuzzy match, web enrichment, HubSpot lookup, resolve. Returns the rule, assigned rep, explanation, and action buttons to assign directly from Slack. |
| `/audit-me` | Runs the 90-day conflict audit for your rep. Lists every conflict sorted by most recent activity, with HubSpot links. |
| `/fix [record ID or company name]` | Looks up a HubSpot record, runs resolution, shows current vs correct owner with Approve/Decline buttons. |

### Running locally (Socket Mode)

```bash
npm install
# Fill in .env — see .env.example
node server.js
# or: npm start
```

Requires `SLACK_APP_TOKEN` in `.env` for Socket Mode (no public URL needed).

---

## Deploy to Cloud Run

Cloud Run runs the bot in HTTP mode — no `SLACK_APP_TOKEN` needed, just the bot token and signing secret.

### Prerequisites

- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) installed and authenticated
- A GCP project with billing enabled

### 1 — Enable APIs (one-time per project)

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com
```

### 2 — Create an Artifact Registry repository (one-time)

```bash
gcloud artifacts repositories create landing-ownership \
  --repository-format=docker \
  --location=us-central1
```

### 3 — Build and push the container

```bash
export PROJECT_ID=$(gcloud config get-value project)
export REGION=us-central1
export IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/landing-ownership/bot

gcloud builds submit --tag $IMAGE
```

### 4 — Deploy to Cloud Run

Replace the `...` values with your real secrets. Do **not** include `SLACK_APP_TOKEN` — that enables Socket Mode, which won't work on Cloud Run.

```bash
gcloud run deploy landing-ownership-bot \
  --image $IMAGE \
  --platform managed \
  --region $REGION \
  --allow-unauthenticated \
  --min-instances 1 \
  --timeout 300 \
  --no-cpu-throttling \
  --set-env-vars "HUBSPOT_TOKEN=pat-na1-...,HUBSPOT_PORTAL_ID=20754835,SLACK_BOT_TOKEN=xoxb-...,SLACK_SIGNING_SECRET=..."
```

> `--min-instances 1` keeps the bot warm so it responds instantly.
> `--timeout 300` gives `/audit-me` enough time to finish (audit can take 30–60s).

### 5 — Get the public URL

```bash
gcloud run services describe landing-ownership-bot \
  --platform managed \
  --region us-central1 \
  --format 'value(status.url)'
```

### 6 — Set the Request URL in Slack

Take the URL from step 5 and set it in **two places** in your Slack app settings:

- **Slash Commands** → each of `/check`, `/audit-me`, `/fix` → Request URL: `https://<your-url>/slack/events`
- **Interactivity & Shortcuts** → Request URL: `https://<your-url>/slack/events`

### Re-deploying after code changes

```bash
gcloud builds submit --tag $IMAGE && \
gcloud run deploy landing-ownership-bot \
  --image $IMAGE \
  --platform managed \
  --region $REGION \
  --no-cpu-throttling
```

> **Note:** `data/cache.json` and `data/log.json` are written inside the container and reset on each new deployment. For persistent logs, mount a Cloud Storage bucket or push log entries to a database.

---

For full architecture details, see [CLAUDE.md](./CLAUDE.md).
