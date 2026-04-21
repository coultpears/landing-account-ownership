"""
Parse a CoStar 'Space Availability with Photo Report' PDF into structured JSON.

Uses positional character data (not linear text) to disambiguate the two-column
Contacts section — CoStar places the owner entity block on the left and named
individual contacts on the right. pdfplumber's extract_text() merges them into
unusable garbage.

Emits one object per property to stdout (newline-delimited JSON).
Usage: python scripts/parse-costar-pdf.py <path-to-pdf>
"""
import sys, re, json
import pdfplumber
from collections import defaultdict

# Column boundary (x-coordinate) between left (entity) and right (named contact)
# columns in the Contacts section. Determined empirically on the test PDF.
CONTACTS_COL_SPLIT_X = 140.0

# --------------------------------------------------------------------------
# Parsers for repeating blocks on each property page
# --------------------------------------------------------------------------

US_STATE_ABBR = {
    'Alabama':'AL','Alaska':'AK','Arizona':'AZ','Arkansas':'AR','California':'CA',
    'Colorado':'CO','Connecticut':'CT','Delaware':'DE','Florida':'FL','Georgia':'GA',
    'Hawaii':'HI','Idaho':'ID','Illinois':'IL','Indiana':'IN','Iowa':'IA',
    'Kansas':'KS','Kentucky':'KY','Louisiana':'LA','Maine':'ME','Maryland':'MD',
    'Massachusetts':'MA','Michigan':'MI','Minnesota':'MN','Mississippi':'MS',
    'Missouri':'MO','Montana':'MT','Nebraska':'NE','Nevada':'NV','New Hampshire':'NH',
    'New Jersey':'NJ','New Mexico':'NM','New York':'NY','North Carolina':'NC',
    'North Dakota':'ND','Ohio':'OH','Oklahoma':'OK','Oregon':'OR','Pennsylvania':'PA',
    'Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD','Tennessee':'TN',
    'Texas':'TX','Utah':'UT','Vermont':'VT','Virginia':'VA','Washington':'WA',
    'West Virginia':'WV','Wisconsin':'WI','Wyoming':'WY',
}
STATE_NAME_PATTERN = '|'.join(re.escape(n) for n in sorted(US_STATE_ABBR.keys(), key=len, reverse=True))

EMAIL_RE = re.compile(r'[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')
PHONE_RE = re.compile(r'\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}')
WEB_RE   = re.compile(r'(?:https?://)?(?:www\.)?([a-zA-Z0-9-]+\.(?:com|net|org|io|co|us|biz|info|realty|properties|capital|group|partners|re|us))\b', re.IGNORECASE)

PROPERTY_HEADER_RE = re.compile(
    r'^(\d+)\s+(.+?)\s+-\s+(.+?)$'  # "1 505 Chatham Ave - Modera Creative Village"
)

# City line examples:
#  "Orlando, Florida 32801 (Orange County) - Creative Village Submarket Apartments"
#  "Las Vegas, Nevada 89134 - Downtown Submarket Apartments"
CITY_LINE_RE = re.compile(
    r'^(?P<city>[A-Za-z][A-Za-z\s.\-]+?),\s+'
    r'(?P<state>' + STATE_NAME_PATTERN + r')\s+'
    r'(?P<zip>\d{5}(?:-\d{4})?)'
    r'(?:\s+\((?P<county>[^)]+)\))?'
    r'\s*-\s*'
    r'(?P<submarket>.+?)\s+'
    r'(?P<ptype>Apartments|Apartment|Multifamily|[A-Z][a-z]+)\s*$'
)

def join_wrapped_lines(lines):
    """Pre-process a block to fix CoStar's column-wrap artifacts:
    - line ending with '-' joins with next line (hyphen removal, no space)
    - URL continuation across multiple lines, including the triple-wrap case:
        'www.foo-' / 'barco' / '.com'  ->  'www.foobarco.com'
    - 'www.foo.' / 'com'               ->  'www.foo.com'
    - 'foo.' / 'com'                   ->  'foo.com'
    """
    TLD_ONLY_RE = re.compile(r'^\s*\.?(com|net|org|io|co|us|biz|info|realty|properties|capital|group|partners|re)\b', re.IGNORECASE)

    out = []
    i = 0
    while i < len(lines):
        cur = lines[i].rstrip()
        # Join while current line appears unfinished
        while i + 1 < len(lines):
            nxt = lines[i+1].strip()
            if not nxt: break

            # Hyphen wrap: "Corpora-" + "tion" -> "Corporation"
            # Also: "www.republicfamilyofcompa-" + "nies" -> "www.republicfamilyofcompanies"
            if cur.endswith('-'):
                cur = cur[:-1] + nxt
                i += 1
                continue

            # URL-continuation: current contains a URL fragment without TLD yet,
            # AND next line is either a bare TLD or starts with one
            if re.search(r'(https?://|www\.)[A-Za-z0-9.-]+$', cur) and TLD_ONLY_RE.match(nxt):
                cur = cur.rstrip() + (nxt if nxt.startswith('.') else '.' + nxt)
                i += 1
                continue

            # URL already has trailing "." — join next TLD-like line
            if re.search(r'[A-Za-z0-9]\.\s*$', cur) and re.match(r'^(com|net|org|io|co|us|biz|info|realty|properties|capital|group|partners|re)\b', nxt, re.IGNORECASE):
                cur = cur.rstrip() + nxt
                i += 1
                continue
            break
        # Collapse internal whitespace artifacts ("nies .com" -> "nies.com")
        cur = re.sub(r'\s+\.', '.', cur)
        cur = re.sub(r'\.\s+([a-z]{2,4})\b', r'.\1', cur)
        out.append(cur.strip())
        i += 1
    return out

def parse_entity_lines(lines):
    """Parse a cleaned (pre-joined) set of left-column lines for one entity.
    Returns {name, street, city, state, zip, phone, website}.

    Strategy:
      - First line(s) = company name. Keep absorbing lines into the name
        until we see an address-start indicator (line starts with digit, OR
        street-keyword like 'PO Box', OR a city/state/zip line).
      - Then accumulate street until city-line.
      - City-line sets city/state/zip.
      - After city, any phone or website line captured.
    """
    out = {'street': None, 'city': None, 'state': None, 'zip': None, 'phone': None, 'website': None}
    lines = [l.strip() for l in lines if l.strip()]
    if not lines:
        return {'name': None, **out}

    STREET_START = re.compile(r'^(\d|PO Box\b|P\.O\. Box\b|Po Box\b)', re.IGNORECASE)
    CITY_LINE    = re.compile(r'^([A-Za-z][A-Za-z\s.\-\']+),\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)(?:\s+USA)?\s*$')
    PHONE_ONLY   = re.compile(r'^[\s()\d.\-]+$')

    # Phase 1: collect name until address-start
    name_parts = []
    idx = 0
    while idx < len(lines):
        l = lines[idx]
        if STREET_START.match(l) or CITY_LINE.match(l):
            break
        # Phone-only or URL-only shouldn't be in name phase either
        if PHONE_ONLY.match(l) and PHONE_RE.search(l):
            break
        if re.match(r'^(https?://|www\.)', l) or re.fullmatch(WEB_RE, l):
            break
        name_parts.append(l)
        idx += 1

    name = ' '.join(name_parts).strip()
    # Clean trailing punctuation artifacts
    name = re.sub(r',\s*$', '', name)

    # Phase 2: address, phone, website
    street_parts = []
    for l in lines[idx:]:
        cm = CITY_LINE.match(l)
        if cm:
            out['city'], out['state'], out['zip'] = cm.group(1).strip(), cm.group(2), cm.group(3)
            continue
        # Phone line?
        pm = PHONE_RE.search(l)
        if pm and PHONE_ONLY.match(l):
            out['phone'] = pm.group(0)
            continue
        # Website?
        wm = WEB_RE.search(l)
        if wm and not EMAIL_RE.search(l):
            out['website'] = wm.group(1).lower()
            continue
        # Default: street fragment
        street_parts.append(l)
    if street_parts:
        out['street'] = ' '.join(street_parts).strip()

    return {'name': name or None, **out}

def parse_address_block(lines):
    """Legacy API — now a thin wrapper around parse_entity_lines that returns
    only the address fields (no name). Kept for one caller; prefer the new
    split_entities_from_left_column path."""
    joined = join_wrapped_lines(lines)
    parsed = parse_entity_lines(joined)
    return {k: parsed[k] for k in ('street','city','state','zip','phone','website')}

def extract_named_contacts(lines):
    """A 'named contact' line looks like:
        'Wesley Dickerson'
        'Executive Vice President, Acquisitions wdickerson@ffres.com (512) 593-7208'
    Extract (name, title, email, phone) tuples from a block of lines.
    """
    contacts = []
    i = 0
    while i < len(lines):
        l = lines[i].strip()
        # Next line has an email? that's the title+email+phone line
        if i + 1 < len(lines):
            nxt = lines[i+1].strip()
            em = EMAIL_RE.search(nxt)
            if em and re.match(r'^[A-Z][a-zA-Z\'.\-]+\s+[A-Z][a-zA-Z\'.\-]+(?:\s+[A-Z][a-zA-Z\'.\-]+)?$', l):
                phone = PHONE_RE.search(nxt)
                title = nxt[:em.start()].strip().rstrip(',').strip()
                contacts.append({
                    'name': l,
                    'title': title,
                    'email': em.group(0).lower(),
                    'phone': phone.group(0) if phone else None
                })
                i += 2
                continue
        i += 1
    return contacts

# --------------------------------------------------------------------------
# Property-summary key/value extraction
# --------------------------------------------------------------------------

SUMMARY_KEYS = [
    'Units', 'Vacancy %', 'Built', 'Year Renovated', 'Stories', 'Elevators',
    'Market Segment', 'Parking Spaces', 'Asking Rent Per Unit',
    'Commercial Available', 'Commercial Asking Rent', 'True Owner', 'Star Rating'
]

def parse_property_summary(block_text):
    """The block has a 2-column layout. Pdfplumber linearizes it, so we
    tokenize against the known key set."""
    out = {}
    # Split into "Key Value Key Value ..." — greedy-match each known key
    keys_pattern = '|'.join(re.escape(k) for k in SUMMARY_KEYS)
    # Find every key and the span until the next key
    positions = [(m.start(), m.end(), m.group(0)) for m in re.finditer(keys_pattern, block_text)]
    positions.sort()
    for idx, (s, e, key) in enumerate(positions):
        val_start = e
        val_end = positions[idx+1][0] if idx+1 < len(positions) else len(block_text)
        val = block_text[val_start:val_end].strip(' :\n\t')
        if val:
            out[key] = val
    return out

# --------------------------------------------------------------------------
# Main page parser
# --------------------------------------------------------------------------

def build_line_pairs(page, y_start, y_end):
    """For a vertical slice of the page, build (left_text, right_text) per visual row.
    Uses char positions to split into two columns at CONTACTS_COL_SPLIT_X."""
    rows = defaultdict(list)
    for c in page.chars:
        top = round(c['top'], 0)
        if y_start <= top <= y_end:
            rows[top].append(c)
    out = []
    for top in sorted(rows):
        line = sorted(rows[top], key=lambda c: c['x0'])
        left  = ''.join(c['text'] for c in line if c['x0'] < CONTACTS_COL_SPLIT_X)
        right = ''.join(c['text'] for c in line if c['x0'] >= CONTACTS_COL_SPLIT_X)
        out.append((left.rstrip(), right.rstrip()))
    return out

def parse_contacts_block(page, line_text_to_y):
    """Find the Contacts section on the page, carve out each sub-section
    (Recorded Owner / True Owner / Primary Leasing Company), and return
    a structured dict.

    line_text_to_y maps linearized-text lines to their y-coordinate top —
    used to locate sub-section boundaries positionally."""
    result = {'recorded_owner': None, 'true_owners': [], 'leasing_companies': []}

    # Find the Contacts section y-range
    contacts_y = line_text_to_y.get('Contacts')
    if contacts_y is None: return result

    # Find sub-section y-positions within Contacts
    sub_headers = [('Recorded Owner','recorded_owner'),
                   ('True Owner','true_owners'),
                   ('Primary Leasing Company','leasing_companies'),
                   ('Property Manager','_ignored'),  # not ingested, but terminates True Owner block
                   ('Property Management','_ignored'),
                   ('Sales Company','_ignored'),
                   ('Primary Leasing','_ignored')]
    sub_positions = []
    for h, key in sub_headers:
        # Find this header at or below contacts_y
        for ltext, y in sorted(line_text_to_y.items(), key=lambda kv: kv[1]):
            if ltext == h and y > contacts_y:
                sub_positions.append((y, h, key))
                break

    # Footer y — where Contacts section ends. Use first of: known footer marker,
    # any "Property Notes" / "Amenities" / "Photos" text appearing below
    # contacts_y (content that comes AFTER Contacts on rare layouts), or 1000.
    footer_y = line_text_to_y.get('Footer', 1000)
    for stopper in ('Property Notes', 'Property Photos', 'Photos', 'Map', 'Location Map', 'Unit Mix', 'Building Summary'):
        y = line_text_to_y.get(stopper)
        if y is not None and y > contacts_y and y < footer_y:
            footer_y = y
    sub_positions.sort()

    for i, (y_hdr, header, key) in enumerate(sub_positions):
        y_top = y_hdr + 1  # skip the header line itself
        y_bot = sub_positions[i+1][0] - 1 if i+1 < len(sub_positions) else footer_y
        rows = build_line_pairs(page, y_top, y_bot)
        # For each row we now have (left, right). Left is the entity address
        # block (possibly concatenating multiple entities for JV cases). Right
        # is the named-contact column.
        entities = split_entities_from_left_column([l for (l,r) in rows])
        named = parse_named_contacts_from_right_column([r for (l,r) in rows])

        # Attach named contacts to the FIRST entity (most common pattern for
        # True Owner; for Recorded Owner the right column is usually empty).
        if entities and named:
            entities[0]['contacts'] = named

        # Filter defensively: reject entities whose "name" looks like body text
        # instead of a company name (too long, starts with obvious non-name words,
        # contains sentence-like content). Guards against parse bleed-through
        # from Property Manager / Property Notes sections on odd layouts.
        entities = [e for e in entities if _looks_like_company_name(e.get('name'))]

        if key == '_ignored':
            continue  # terminator header; we only need its y-position for bounds
        if key == 'recorded_owner':
            if entities: result['recorded_owner'] = entities[0]
        else:
            result[key].extend(entities)

    return result

def _looks_like_company_name(name):
    """Heuristic: reject obvious non-names that sometimes slip through the
    Contacts parser when the page layout puts adjacent sections close."""
    if not name: return False
    n = name.strip()
    # Too long — real company names are rarely over 80 chars
    if len(n) > 80: return False
    # Starts with obvious body-text words
    if re.match(r'^(Property Manager|Property Notes|Property Photos|Property Type|Sales Company|Market Segment|Amenities|Looking for|Photos|Unit Mix|Building Summary)\b', n, re.IGNORECASE):
        return False
    # Content-based rejection (catches mid-string amenity text that a name line
    # shouldn't have): "Amenities", "Property Summary", "Stories4", "Built2022",
    # "Units123", "Market Segment", "Parking Spaces"
    if re.search(r'\bAmenities\b|\bProperty Summary\b|\bStories\d|\bElevators\d|\bUnits\d|\bBuilt\d{4}|\bMarket Segment\b|\bParking Spaces\b', n, re.IGNORECASE):
        return False
    # Sentence-like (multi-clause with commas that aren't in a typical suffix pattern)
    # Real names may have ", Inc" / ", LLC" / ", LP" / ", Ltd" — allow those but
    # block runs with 3+ commas (likely body text).
    if n.count(',') >= 3: return False
    return True

_URL_LINE_RE   = re.compile(r'^(https?://|www\.|[a-z0-9.-]+\.(?:com|net|org|io|co|us|biz|info|realty|properties|capital|group|partners|re))$', re.IGNORECASE)
_CITY_LINE_RE  = re.compile(r'^([A-Za-z][A-Za-z\s.\-\']+),\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?(?:\s+USA)?\s*$')
_STREET_START  = re.compile(r'^(\d|PO Box|P\.O\. Box|Po Box|Suite\b)', re.IGNORECASE)

def _is_end_marker(l):
    if PHONE_RE.fullmatch(l): return True
    if _URL_LINE_RE.match(l) and not EMAIL_RE.search(l): return True
    return False

def _is_name_line(l):
    """Does this line look like an entity name (start of a new entity)?"""
    if _STREET_START.match(l): return False
    if _CITY_LINE_RE.match(l): return False
    if PHONE_RE.fullmatch(l):  return False
    if _URL_LINE_RE.match(l):  return False
    if re.match(r'^USA$', l):  return False
    # Names start with a capital letter (can include "The", "XYZ, Inc.", etc.)
    return bool(re.match(r'^[A-Z]', l))

def split_entities_from_left_column(left_lines):
    """Given left-column lines for a Contacts sub-section, split into one or
    more entities and parse each.

    Entity boundary rule: a new entity starts when we encounter a line that
    looks like an entity name AND the previous line was an 'end marker' (phone
    or website). Otherwise subsequent lines continue the current entity.

    CoStar formats each entity consistently: Name [wrap] / Street / City / Phone / Website.
    So end-marker → next name-line is a reliable boundary.
    """
    # Step 1: clean + pre-join wrapped lines (hyphen wrap, URL wrap)
    cleaned = []
    for l in left_lines:
        l = l.strip()
        if not l: continue
        if re.search(r'CoStar Group', l) or re.match(r'^Page \d+$', l): continue
        cleaned.append(l)
    cleaned = join_wrapped_lines(cleaned)

    # Step 2: split into entity blocks
    blocks = []
    cur = []
    prev_was_end_marker = False
    for l in cleaned:
        if prev_was_end_marker and _is_name_line(l):
            if cur: blocks.append(cur)
            cur = []
        cur.append(l)
        prev_was_end_marker = _is_end_marker(l)
    if cur: blocks.append(cur)

    # Step 3: parse each block
    entities = []
    for block in blocks:
        parsed = parse_entity_lines(block)
        if parsed.get('name'):
            entities.append({**parsed, 'contacts': []})
    return entities

def parse_named_contacts_from_right_column(right_lines):
    """Right column has named contacts: NAME on one line, then '[TITLE] email phone' on the next.
    Some contacts span multiple right-column lines (title may wrap)."""
    # Clean: drop empty, drop footer artifacts, join wrapped lines
    raw = []
    for l in right_lines:
        l = l.strip()
        if not l: continue
        if re.search(r'CoStar Group', l) or re.match(r'^Page \d+$', l): continue
        raw.append(l)
    clean = join_wrapped_lines(raw)

    contacts = []
    i = 0
    while i < len(clean):
        # Name pattern: 1-3 capitalized words, no email, no digits
        if re.match(r'^[A-Z][A-Za-z\'.\-]+(?:\s+[A-Z][A-Za-z\'.\-]+){1,2}$', clean[i]):
            name = clean[i]
            # Collect following lines until we hit another name line or end
            j = i + 1
            title_email_phone = []
            while j < len(clean) and not re.match(r'^[A-Z][A-Za-z\'.\-]+(?:\s+[A-Z][A-Za-z\'.\-]+){1,2}$', clean[j]):
                title_email_phone.append(clean[j])
                j += 1
            joined = ' '.join(title_email_phone)
            em = EMAIL_RE.search(joined)
            ph = PHONE_RE.search(joined)
            title = joined
            if em: title = title.replace(em.group(0), '')
            if ph: title = title.replace(ph.group(0), '')
            title = re.sub(r'\s+', ' ', title).strip(' ,')
            if em or title:
                contacts.append({
                    'name': name,
                    'title': title or None,
                    'email': em.group(0).lower() if em else None,
                    'phone': ph.group(0) if ph else None,
                })
            i = j
        else:
            i += 1
    return contacts

def parse_page(text, page_num, page=None):
    lines = text.splitlines()
    prop = {
        'page': page_num,
        'property_index': None,
        'property_name': None,
        'property_street_address': None,
        'property_city': None,
        'property_state': None,
        'property_state_full': None,
        'property_zip': None,
        'county': None,
        'submarket': None,
        'costar_property_type': None,

        'costar_total_units': None,
        'vacancy_pct': None,
        'costar_year_built': None,
        'costar_year_renovated': None,
        'costar_stories': None,
        'costar_parking': None,
        'costar_market_segment': None,
        'costar_star_rating': None,
        'costar_asking_rent_per_unit': None,
        'costar_commercial_available_sf': None,
        'costar_commercial_asking_rent': None,

        'costar_building_status': None,    # inferred from 'Built > currentYear' if missing

        'true_owner_header': None,   # name referenced in Property Summary "True Owner" cell

        'contacts': {
            'recorded_owner': None,   # {name, address-block...}
            'true_owners': [],        # list of {name, address-block, contacts}
            'leasing_companies': [],  # list of {name, address-block, contacts}
        },

        'property_notes': None,
        'costar_amenities_unit': None,
        'costar_amenities_site': None,
        'parse_warnings': []
    }

    # --- Header / city lines
    for i, l in enumerate(lines[:4]):
        m = PROPERTY_HEADER_RE.match(l.strip())
        if m:
            prop['property_index'] = int(m.group(1))
            prop['property_street_address'] = m.group(2).strip()
            prop['property_name'] = m.group(3).strip()
            # Next non-empty line is the city line
            for cl in lines[i+1:i+4]:
                cm = CITY_LINE_RE.match(cl.strip())
                if cm:
                    prop['property_city'] = cm.group('city').strip()
                    prop['property_state_full'] = cm.group('state').strip()
                    prop['property_state']     = US_STATE_ABBR.get(cm.group('state').strip(), '')
                    prop['property_zip']       = cm.group('zip')
                    prop['county']             = (cm.group('county') or '').strip() or None
                    prop['submarket']          = cm.group('submarket').strip()
                    prop['costar_property_type']= cm.group('ptype')
                    break
            break

    # --- Carve the page into sections (Property Summary / Amenities / Property Notes / Contacts)
    section_positions = []
    for i, l in enumerate(lines):
        ls = l.strip()
        if ls in ('Property Summary','Amenities','Property Notes','Contacts'):
            section_positions.append((i, ls))

    sections = {}
    for idx, (i, name) in enumerate(section_positions):
        end = section_positions[idx+1][0] if idx+1 < len(section_positions) else len(lines)
        sections[name] = lines[i+1:end]

    # Property Summary
    if 'Property Summary' in sections:
        block = '\n'.join(sections['Property Summary'])
        summary = parse_property_summary(block)

        def num(v, *, flt=False):
            if v is None: return None
            s = re.sub(r'[,$%]', '', v).strip()
            try:
                return float(s) if flt else int(re.match(r'-?\d+', s).group(0))
            except Exception:
                return None

        prop['costar_total_units']           = num(summary.get('Units'))
        prop['vacancy_pct']                  = num(summary.get('Vacancy %'), flt=True)
        prop['costar_year_built']            = num(summary.get('Built'))
        prop['costar_year_renovated']        = num(summary.get('Year Renovated'))
        prop['costar_stories']               = summary.get('Stories')
        prop['costar_parking']               = summary.get('Parking Spaces')
        prop['costar_market_segment']        = summary.get('Market Segment')
        prop['costar_star_rating']           = num(summary.get('Star Rating'))
        prop['costar_asking_rent_per_unit']  = num(summary.get('Asking Rent Per Unit'))
        prop['costar_commercial_available_sf']= summary.get('Commercial Available')
        prop['costar_commercial_asking_rent']= summary.get('Commercial Asking Rent')
        prop['true_owner_header']            = summary.get('True Owner')

    # Amenities
    if 'Amenities' in sections:
        for l in sections['Amenities']:
            ls = l.strip()
            if ls.startswith('Unit Amenities:'):
                prop['costar_amenities_unit'] = ls.replace('Unit Amenities:','').strip()
            elif ls.startswith('Site Amenities:'):
                prop['costar_amenities_site'] = ls.replace('Site Amenities:','').strip()

    # Property Notes
    if 'Property Notes' in sections:
        txt = ' '.join(l.strip() for l in sections['Property Notes'] if l.strip())
        if txt: prop['property_notes'] = txt

    # Contacts — use positional parsing (char-level column split)
    if page is not None:
        # Build map of linearized-text line → y (top) for section-finding
        line_text_to_y = {}
        rows = defaultdict(list)
        for c in page.chars:
            rows[round(c['top'], 0)].append(c)
        for y in sorted(rows):
            t = ''.join(c['text'] for c in sorted(rows[y], key=lambda c: c['x0'])).strip()
            if t and t not in line_text_to_y:
                line_text_to_y[t] = y
        # Map the footer
        for t in line_text_to_y:
            if 'CoStar Group' in t:
                line_text_to_y['Footer'] = line_text_to_y[t]
                break

        parsed = parse_contacts_block(page, line_text_to_y)
        prop['contacts'] = parsed

    # Infer building status
    import datetime
    if prop['costar_year_built'] and prop['costar_year_built'] > datetime.datetime.now().year:
        prop['costar_building_status'] = 'Under Construction'
    else:
        prop['costar_building_status'] = 'Existing'

    # Warnings
    if not prop['property_name']:
        prop['parse_warnings'].append('missing property_name')
    if not prop['contacts']['true_owners']:
        prop['parse_warnings'].append('no True Owner contact block')
    elif not prop['contacts']['true_owners'][0].get('website'):
        prop['parse_warnings'].append('True Owner has no website/domain')

    return prop

# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main(path):
    with pdfplumber.open(path) as pdf:
        # Accumulate pages by property_index: CoStar may wrap onto a second page
        # when amenities+contacts are long. We treat each page independently and
        # merge by property_index post-hoc if needed.
        props_by_idx = {}
        unmatched = []
        for i, page in enumerate(pdf.pages):
            txt = page.extract_text() or ''
            if 'Property Summary' not in txt and 'Contacts' not in txt:
                continue
            prop = parse_page(txt, i+1, page=page)
            if prop['property_index'] is None:
                unmatched.append({'page': i+1, 'preview': txt[:200]})
                continue
            # Merge if property_index already seen (continuation page)
            idx = prop['property_index']
            if idx in props_by_idx:
                existing = props_by_idx[idx]
                # Pull missing data forward
                for k, v in prop.items():
                    if v in (None, '', [], {}): continue
                    if existing.get(k) in (None, '', [], {}):
                        existing[k] = v
                # Merge contacts
                for entity_type in ('true_owners','leasing_companies'):
                    existing['contacts'][entity_type].extend(prop['contacts'][entity_type])
                if prop['contacts']['recorded_owner'] and not existing['contacts']['recorded_owner']:
                    existing['contacts']['recorded_owner'] = prop['contacts']['recorded_owner']
            else:
                props_by_idx[idx] = prop

    results = [props_by_idx[k] for k in sorted(props_by_idx)]
    # Emit NDJSON for easy piping, plus a summary
    for p in results:
        sys.stdout.write(json.dumps(p, ensure_ascii=False) + '\n')
    # Summary goes to stderr so stdout is pure NDJSON
    sys.stderr.write(f'\n=== PARSE SUMMARY ===\n')
    sys.stderr.write(f'Properties: {len(results)}\n')
    sys.stderr.write(f'With True Owner website (→ usable domain): '
                     f'{sum(1 for p in results if p["contacts"]["true_owners"] and p["contacts"]["true_owners"][0].get("website"))}\n')
    sys.stderr.write(f'Without True Owner contact block:        '
                     f'{sum(1 for p in results if not p["contacts"]["true_owners"])}\n')
    sys.stderr.write(f'Multi-True-Owner (JV) properties:        '
                     f'{sum(1 for p in results if len(p["contacts"]["true_owners"]) > 1)}\n')
    sys.stderr.write(f'With named individual contacts:          '
                     f'{sum(1 for p in results if any(e.get("contacts") for e in p["contacts"]["true_owners"]))}\n')
    sys.stderr.write(f'With leasing company:                    '
                     f'{sum(1 for p in results if p["contacts"]["leasing_companies"])}\n')
    sys.stderr.write(f'Unmatched pages (no property index):     {len(unmatched)}\n')
    sys.stderr.write(f'Parse warnings (non-fatal):              '
                     f'{sum(1 for p in results if p["parse_warnings"])}\n')

if __name__ == '__main__':
    main(sys.argv[1])
