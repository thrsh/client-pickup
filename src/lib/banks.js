// lib/banks.js
//
// Single source of truth for the fixed list of banks a check can be drawn
// on. Previously this list was hardcoded directly inside AdminChecks.jsx
// (the upload/register form). Pulling it out here means AdminPickups.jsx
// (the pickup/approval workflow) can filter and display by the exact same
// set of banks without a second, independently-maintained copy that could
// silently drift out of sync — e.g. someone adds a bank to the upload form
// but forgets the pickups page, and now a valid `checks.bank` value has
// nowhere to show up in the Pickups bank filter dropdown.
//
// IMPORTANT: if you add/rename/remove a bank here, existing rows in the
// `checks.bank` column keep whatever string they already have — this file
// does not retroactively rewrite data. Renaming an entry here will make
// existing checks with the old string show up as "Unknown" in BankBadge
// until they're corrected, so prefer ADDING a new entry over renaming one
// in place unless you're also running a data migration.
export const BANKS = [
  'BDO Unibank',
  'Bank of the Philippine Islands (BPI)',
  'Metrobank',
  'Land Bank of the Philippines',
  'Philippine National Bank (PNB)',
  'China Banking Corporation (Chinabank)',
  'Rizal Commercial Banking Corporation (RCBC)',
  'Security Bank',
  'UnionBank of the Philippines',   
  'EastWest Bank',
  'Philippine Savings Bank (PSBank)',
]