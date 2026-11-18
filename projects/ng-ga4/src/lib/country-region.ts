// ISO 3166-1 alpha-2 country code -> UN M49 continent and subcontinent codes.
//
// The Measurement Protocol's `user_location` accepts `continent_id` and
// `subcontinent_id` as UN M49 codes: three-digit, zero-padded strings such as
// '019' (Americas) and '021' (Northern America). Unlike city or region, both are
// a fixed function of the country, so once tz-country.ts has guessed a country we
// can fill them in without any further signal.
//
// Derived from the UN Statistics Division's M49 "Overview" table
// (https://unstats.un.org/unsd/methodology/m49/overview/):
//
// - continent_id is the M49 Region (002, 009, 019, 142, 150).
// - subcontinent_id is the M49 Sub-region, except inside Sub-Saharan Africa (202)
//   and Latin America and the Caribbean (419), where it is the Intermediate
//   Region (Western Africa 011, Caribbean 029, ...). Those intermediate regions
//   are what GA4 reports as subcontinents, and the MP reference itself gives 011
//   as an example. The one other intermediate region, Channel Islands (830),
//   is not a GA4 subcontinent, so GG and JE stay in Northern Europe (154).
//
// Additions to the UN table: TW, which M49 does not list separately, is placed
// in Eastern Asia as GA4 reports it. AQ has no M49 region and is left out, so
// the lookup returns undefined and only country_id is sent.

interface CountryRegion {
    continent_id: string;
    subcontinent_id: string;
}

// [continent_id, subcontinent_id, space-separated alpha-2 codes]
const M49_GROUPS: ReadonlyArray<readonly [string, string, string]> = [
    // Africa (002)
    // Western Africa
    ['002', '011', 'BF BJ CI CV GH GM GN GW LR ML MR NE NG SH SL SN TG'],
    // Eastern Africa
    ['002', '014', 'BI DJ ER ET IO KE KM MG MU MW MZ RE RW SC SO SS TF TZ UG YT ZM ZW'],
    // Northern Africa
    ['002', '015', 'DZ EG EH LY MA SD TN'],
    // Middle Africa
    ['002', '017', 'AO CD CF CG CM GA GQ ST TD'],
    // Southern Africa
    ['002', '018', 'BW LS NA SZ ZA'],

    // Americas (019)
    // South America
    ['019', '005', 'AR BO BR BV CL CO EC FK GF GS GY PE PY SR UY VE'],
    // Central America
    ['019', '013', 'BZ CR GT HN MX NI PA SV'],
    // Northern America
    ['019', '021', 'BM CA GL PM US'],
    // Caribbean
    ['019', '029', 'AG AI AW BB BL BQ BS CU CW DM DO GD GP HT JM KN KY LC MF MQ MS PR SX TC TT VC VG VI'],

    // Asia (142)
    // Eastern Asia
    ['142', '030', 'CN HK JP KP KR MN MO TW'],
    // Southern Asia
    ['142', '034', 'AF BD BT IN IR LK MV NP PK'],
    // South-eastern Asia
    ['142', '035', 'BN ID KH LA MM MY PH SG TH TL VN'],
    // Central Asia
    ['142', '143', 'KG KZ TJ TM UZ'],
    // Western Asia
    ['142', '145', 'AE AM AZ BH CY GE IL IQ JO KW LB OM PS QA SA SY TR YE'],

    // Europe (150)
    // Southern Europe
    ['150', '039', 'AD AL BA ES GI GR HR IT ME MK MT PT RS SI SM VA'],
    // Eastern Europe
    ['150', '151', 'BG BY CZ HU MD PL RO RU SK UA'],
    // Northern Europe
    ['150', '154', 'AX DK EE FI FO GB GG IE IM IS JE LT LV NO SE SJ'],
    // Western Europe
    ['150', '155', 'AT BE CH DE FR LI LU MC NL'],

    // Oceania (009)
    // Australia and New Zealand
    ['009', '053', 'AU CC CX HM NF NZ'],
    // Melanesia
    ['009', '054', 'FJ NC PG SB VU'],
    // Micronesia
    ['009', '057', 'FM GU KI MH MP NR PW UM'],
    // Polynesia
    ['009', '061', 'AS CK NU PF PN TK TO TV WF WS']
];

// A Map rather than an object literal, so inherited keys like 'constructor'
// can never be mistaken for a country. Each region object is shared by every
// country in its group and handed out as is, so it is frozen.
const COUNTRY_TO_REGION = new Map<string, Readonly<CountryRegion>>();
for (const [continent_id, subcontinent_id, countries] of M49_GROUPS) {
    const region = Object.freeze({ continent_id, subcontinent_id });
    for (const country of countries.split(' ')) {
        COUNTRY_TO_REGION.set(country, region);
    }
}

export function regionFromCountry(country: string | null | undefined): Readonly<CountryRegion> | undefined {
    if (!country) {
        return undefined;
    }
    return COUNTRY_TO_REGION.get(country);
}
