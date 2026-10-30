-- Re-tag postings already in the index after the alpha-3 / province change (location-subdivisions.js).
-- Marks them dirty; src/tasks/meili-sync.js ships them at its own throttled rate (about 2,000
-- documents a minute). Reads every live row's location, so run it off-peak:
--   psql "$(cat ~/.fastapply-database-url)" -f scripts/resync-location-tags-2026-10-30.sql
SET statement_timeout = 0;
UPDATE jobs SET index_dirty_at = now()
WHERE removed_at IS NULL AND (
  location ~ '(^|[;|/]\s*)(CAN|AUS|GBR|IND|DEU|FRA|MEX|BRA|NLD|ESP|ITA|IRL|NZL|SGP|PHL|ZAF|ARE|JPN|CHN|POL|CHE|SWE|BEL|ARG|COL|CHL|KOR|ISR|PRT|AUT|DNK|NOR|FIN|CZE|HUN|ROU|GRC|TUR|SAU|QAT|EGY|NGA|KEN|MYS|THA|IDN|VNM|HKG|TWN|PAK|BGD|LKA|PER|URY|CRI|PAN|DOM|GTM|ECU|SVK|SVN|HRV|SRB|BGR|UKR|LTU|LVA|EST|LUX|ISL|MLT|CYP|MAR|TUN|GHA|KWT|BHR|OMN|JOR)(\s|,|-|/|$)'
  OR location ~ '(,|\s-\s)\s*(CAN|AUS|GBR|IND|DEU|FRA|MEX|BRA|NLD|ESP|ITA|IRL|NZL|SGP|PHL|ZAF|ARE|JPN|CHN|POL|CHE|SWE|BEL|ARG|COL|CHL|KOR|ISR|PRT|AUT|DNK|NOR|FIN|CZE|HUN|ROU|GRC|TUR|SAU|QAT|EGY|NGA|KEN|MYS|THA|IDN|VNM|HKG|TWN|PAK|BGD|LKA|PER|URY|CRI|PAN|DOM|GTM|ECU|SVK|SVN|HRV|SRB|BGR|UKR|LTU|LVA|EST|LUX|ISL|MLT|CYP|MAR|TUN|GHA|KWT|BHR|OMN|JOR)\s*($|[;|/])'
  OR location ~ '\m(NSW|QLD|VIC|TAS|ACT|ON|AB|QC|BC|MB|NS|NB|NL|PE|SK|SA|NT|YT|NU)(\s+\d{4})?\s*($|[;|/])'
  OR location ~ 'Victoria(\s+\d{4})?\s*$'
  OR location ~* '\m(ontario|qu[eé]bec|british columbia|alberta|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland|prince edward island|yukon|northwest territories|nunavut|queensland|tasmania|northern territory)\M'
);
