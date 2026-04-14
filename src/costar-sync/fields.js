'use strict';

/**
 * fields.js — CoStar → HubSpot field mapping and property definitions
 *
 * Maps every CoStar export column to a HubSpot company property.
 * Existing HS fields (city, state, country) are mapped directly.
 * New fields get a costar_ prefix and are auto-created on first sync.
 */

// ---------------------------------------------------------------------------
// Field map: CoStar header → HubSpot property config
// ---------------------------------------------------------------------------

const FIELD_MAP = [
  // CoStar "Company" is used for matching, not written to `name` blindly
  {
    costar:   'Company',
    hubspot:  'name',
    label:    'Company Name',
    type:     'string',
    fieldType:'text',
    builtin:  true,       // already exists in HS — don't create
    matchKey: true        // used for company matching
  },

  // HQ fields — overwrite existing HS fields (CoStar wins)
  {
    costar:   'HQ City',
    hubspot:  'city',
    label:    'City',
    type:     'string',
    fieldType:'text',
    builtin:  true
  },
  {
    costar:   'HQ State',
    hubspot:  'state',
    label:    'State/Region',
    type:     'string',
    fieldType:'text',
    builtin:  true
  },
  {
    costar:   'HQ Country',
    hubspot:  'country',
    label:    'Country/Region',
    type:     'string',
    fieldType:'text',
    builtin:  true
  },

  // CoStar-specific fields — create as custom properties
  {
    costar:   'Hierarchy',
    hubspot:  'costar_hierarchy',
    label:    'CoStar Hierarchy',
    type:     'string',
    fieldType:'text',
    groupName:'costar_data'
  },
  {
    costar:   'Owner Type',
    hubspot:  'costar_owner_type',
    label:    'CoStar Owner Type',
    type:     'string',
    fieldType:'text',
    groupName:'costar_data'
  },
  {
    costar:   'Properties',
    hubspot:  'costar_properties_count',
    label:    'CoStar Properties Count',
    type:     'number',
    fieldType:'number',
    groupName:'costar_data'
  },
  {
    costar:   'Portfolio SF',
    hubspot:  'costar_portfolio_sf',
    label:    'CoStar Portfolio SF',
    type:     'number',
    fieldType:'number',
    groupName:'costar_data'
  },
  {
    costar:   'Average SF',
    hubspot:  'costar_average_sf',
    label:    'CoStar Average SF',
    type:     'number',
    fieldType:'number',
    groupName:'costar_data'
  },
  {
    costar:   'Apt Units',
    hubspot:  'costar_apt_units',
    label:    'CoStar Apt Units',
    type:     'number',
    fieldType:'number',
    groupName:'costar_data'
  },
  {
    costar:   'Hotel Rooms',
    hubspot:  'costar_hotel_rooms',
    label:    'CoStar Hotel Rooms',
    type:     'number',
    fieldType:'number',
    groupName:'costar_data'
  },
  {
    costar:   'Land (Acre)',
    hubspot:  'costar_land_acres',
    label:    'CoStar Land (Acres)',
    type:     'number',
    fieldType:'number',
    groupName:'costar_data'
  },
  {
    costar:   'Main Property Type',
    hubspot:  'costar_main_property_type',
    label:    'CoStar Main Property Type',
    type:     'string',
    fieldType:'text',
    groupName:'costar_data'
  },
  {
    costar:   'SF Delivered 24 Months',
    hubspot:  'costar_sf_delivered_24m',
    label:    'CoStar SF Delivered (24 Mo)',
    type:     'number',
    fieldType:'number',
    groupName:'costar_data'
  },
  {
    costar:   'SF Under Construction',
    hubspot:  'costar_sf_under_construction',
    label:    'CoStar SF Under Construction',
    type:     'number',
    fieldType:'number',
    groupName:'costar_data'
  },
  {
    costar:   'Continental Focus',
    hubspot:  'costar_continental_focus',
    label:    'CoStar Continental Focus',
    type:     'string',
    fieldType:'text',
    groupName:'costar_data'
  },
  {
    costar:   'Primary Country',
    hubspot:  'costar_primary_country',
    label:    'CoStar Primary Country',
    type:     'string',
    fieldType:'text',
    groupName:'costar_data'
  },
  {
    costar:   'Territory',
    hubspot:  'costar_territory',
    label:    'CoStar Territory',
    type:     'string',
    fieldType:'text',
    groupName:'costar_data'
  },
  {
    costar:   'Sale Listings',
    hubspot:  'costar_sale_listings',
    label:    'CoStar Sale Listings',
    type:     'number',
    fieldType:'number',
    groupName:'costar_data'
  },
  {
    costar:   '$ Sale Listings',
    hubspot:  'costar_sale_listings_value',
    label:    'CoStar Sale Listings ($)',
    type:     'string',       // dollar strings with commas — store as text
    fieldType:'text',
    groupName:'costar_data'
  },
  {
    costar:   'Acquisitions 24 Months',
    hubspot:  'costar_acquisitions_24m',
    label:    'CoStar Acquisitions (24 Mo)',
    type:     'string',
    fieldType:'text',
    groupName:'costar_data'
  },
  {
    costar:   'Dispositions 24 Months',
    hubspot:  'costar_dispositions_24m',
    label:    'CoStar Dispositions (24 Mo)',
    type:     'string',
    fieldType:'text',
    groupName:'costar_data'
  }
];

// Timestamp property — written on every sync to track freshness
const SYNC_TIMESTAMP_FIELD = {
  hubspot:   'costar_last_synced',
  label:     'CoStar Last Synced',
  type:      'datetime',
  fieldType: 'date',
  groupName: 'costar_data'
};

// Property group for all costar_ fields
const COSTAR_GROUP = {
  name:        'costar_data',
  label:       'CoStar Data',
  displayOrder: 0
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a { costarHeader → fieldDef } lookup */
function getFieldByCostar() {
  const map = {};
  for (const f of FIELD_MAP) map[f.costar] = f;
  return map;
}

/** All custom (non-builtin) fields that need to be created in HS */
function getCustomFields() {
  return FIELD_MAP.filter(f => !f.builtin);
}

/** Parse a CoStar numeric string like "10,462,451" → 10462451 */
function parseCostarNumber(val) {
  if (val == null || val === '') return null;
  const cleaned = String(val).replace(/[,$]/g, '').trim();
  const num = Number(cleaned);
  return isNaN(num) ? null : num;
}

/** Convert a CoStar row object to HubSpot properties object */
function rowToHubspotProps(row) {
  const props = {};
  const fieldByCostar = getFieldByCostar();

  for (const [header, value] of Object.entries(row)) {
    const field = fieldByCostar[header];
    if (!field) continue;
    if (value == null || String(value).trim() === '') continue;

    // Don't overwrite name — it's used for matching only
    if (field.hubspot === 'name') continue;

    if (field.type === 'number') {
      const num = parseCostarNumber(value);
      if (num !== null) props[field.hubspot] = String(num);
    } else {
      props[field.hubspot] = String(value).trim();
    }
  }

  // Add sync timestamp
  props[SYNC_TIMESTAMP_FIELD.hubspot] = String(Date.now());

  return props;
}

module.exports = {
  FIELD_MAP,
  SYNC_TIMESTAMP_FIELD,
  COSTAR_GROUP,
  getFieldByCostar,
  getCustomFields,
  parseCostarNumber,
  rowToHubspotProps
};
