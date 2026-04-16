require('dotenv').config();
const { apiRequest } = require('../src/costar-sync/hs-extra');

const GROUP = { name: 'costar_data', label: 'CoStar Data', displayOrder: 0 };

const PROPS = [
  // Numbers
  { name: 'costar_total_units',              label: 'Total Units (CoStar)',        type: 'number',   fieldType: 'number',      description: 'Total unit count at the property per CoStar. Distinct from Number of Units (rep-controlled partnership target).' },
  { name: 'costar_year_built',               label: 'Year Built',                  type: 'number',   fieldType: 'number',      description: 'Year the property was built per CoStar.' },
  { name: 'costar_year_renovated',           label: 'Year Renovated',              type: 'number',   fieldType: 'number',      description: 'Year the property was last renovated per CoStar.' },
  { name: 'costar_star_rating',              label: 'CoStar Star Rating',          type: 'number',   fieldType: 'number',      description: 'CoStar quality rating (1-5).' },
  { name: 'costar_asking_rent_per_unit',     label: 'Asking Rent per Unit',        type: 'number',   fieldType: 'number',      description: 'Average asking rent per unit ($) per CoStar.' },

  // Short text
  { name: 'costar_stories',                  label: 'Stories',                     type: 'string',   fieldType: 'text',        description: 'Number of stories at the property per CoStar.' },
  { name: 'costar_parking',                  label: 'Parking',                     type: 'string',   fieldType: 'text',        description: 'Parking detail per CoStar (e.g. "1.34/Unit; 391 Surface Spaces").' },
  { name: 'costar_market_segment',           label: 'Market Segment',              type: 'string',   fieldType: 'text',        description: 'CoStar market segment (e.g. "All", "Vacation").' },
  { name: 'costar_property_type',            label: 'Property Type (CoStar)',      type: 'string',   fieldType: 'text',        description: 'CoStar property type classification.' },
  { name: 'costar_building_status',          label: 'Building Status',             type: 'string',   fieldType: 'text',        description: 'CoStar building status ("Existing", "Under Construction", etc).' },
  { name: 'costar_market',                   label: 'Market',                      type: 'string',   fieldType: 'text',        description: 'CoStar market name.' },
  { name: 'costar_submarket',                label: 'Submarket',                   type: 'string',   fieldType: 'text',        description: 'CoStar submarket name.' },
  { name: 'costar_commercial_available_sf',  label: 'Commercial Available SF',     type: 'string',   fieldType: 'text',        description: 'Commercial SF available per CoStar.' },
  { name: 'costar_commercial_asking_rent',   label: 'Commercial Asking Rent',      type: 'string',   fieldType: 'text',        description: 'Commercial asking rent per CoStar.' },
  { name: 'costar_recorded_owner',           label: 'Recorded Owner (CoStar)',     type: 'string',   fieldType: 'text',        description: 'Recorded owner legal entity per CoStar (not used for matching; audit only).' },
  { name: 'costar_true_owner_contact',       label: 'True Owner Contact (CoStar)', type: 'string',   fieldType: 'text',        description: 'Primary True Owner contact name per CoStar. Reference only.' },
  { name: 'costar_additional_true_owners',   label: 'Additional True Owners',      type: 'string',   fieldType: 'text',        description: 'Additional True Owners listed in the CoStar report beyond the first (for JV/co-owned properties).' },
  { name: 'costar_leasing_company',          label: 'Primary Leasing Company',     type: 'string',   fieldType: 'text',        description: 'Primary leasing company name per CoStar.' },
  { name: 'costar_leasing_company_address',  label: 'Leasing Company Address',     type: 'string',   fieldType: 'text',        description: 'Primary leasing company address per CoStar.' },
  { name: 'costar_leasing_company_phone',    label: 'Leasing Company Phone',       type: 'string',   fieldType: 'phonenumber', description: 'Primary leasing company phone per CoStar.' },
  { name: 'costar_leasing_company_website',  label: 'Leasing Company Website',     type: 'string',   fieldType: 'text',        description: 'Primary leasing company website per CoStar.' },

  // Long text
  { name: 'costar_amenities_unit',           label: 'Unit Amenities',              type: 'string',   fieldType: 'textarea',    description: 'Unit-level amenities list per CoStar.' },
  { name: 'costar_amenities_site',           label: 'Site Amenities',              type: 'string',   fieldType: 'textarea',    description: 'Site-level amenities list per CoStar.' },
  { name: 'costar_property_notes',           label: 'Property Notes (CoStar)',     type: 'string',   fieldType: 'textarea',    description: 'Property notes from CoStar report.' },

  // Datetime
  { name: 'costar_last_synced',              label: 'CoStar Last Synced',          type: 'datetime', fieldType: 'date',        description: 'Timestamp of last CoStar ingest that touched this deal.' }
];

(async () => {
  try {
    await apiRequest('POST', '/crm/v3/properties/deals/groups', GROUP);
    console.log('+ group created:', GROUP.name);
  } catch (e) {
    if (/already exists|PROPERTY_GROUP_DOES_EXIST|409/i.test(e.message || '')) {
      console.log('= group exists:', GROUP.name);
    } else {
      console.log('? group note:', e.message);
    }
  }

  let ok = 0, skip = 0, fail = 0;
  for (const p of PROPS) {
    const payload = { ...p, groupName: GROUP.name, formField: false };
    try {
      await apiRequest('POST', '/crm/v3/properties/deals', payload);
      console.log('+ created', p.name);
      ok++;
    } catch (e) {
      if (/already exists|PROPERTY_ALREADY_EXISTS|409/i.test(e.message || '')) {
        console.log('= exists  ', p.name);
        skip++;
      } else {
        console.error('! FAILED ', p.name, '-', e.message);
        fail++;
      }
    }
  }
  console.log('\nSummary: created', ok, '| existed', skip, '| failed', fail);
})();
