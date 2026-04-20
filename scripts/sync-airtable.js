const { readFileSync, writeFileSync } = require('fs');

const { AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME } = process.env;

if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE_NAME) {
  console.error('Missing required env vars: AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE_NAME');
  process.exit(1);
}

const baseUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`;
const headers = {
  Authorization: `Bearer ${AIRTABLE_TOKEN}`,
  'Content-Type': 'application/json',
};

(async () => {
  const res = await fetch(
    `${baseUrl}?filterByFormula=${encodeURIComponent('{Status}="Approved"')}`,
    { headers }
  );
  if (!res.ok) throw new Error(`Airtable fetch failed: ${res.status} ${await res.text()}`);

  const { records } = await res.json();
  if (!records || records.length === 0) {
    console.log('No approved records found.');
    return;
  }

  let sites = readFileSync('sites.js', 'utf8');

  for (const record of records) {
    const f = record.fields;
    const name        = f['Name'] || '';
    const url         = f['URL'] || '';
    const type        = f['Content type'] || 'website';
    const club        = f['Club / organisation'] || '';
    const location    = f['Location'] || '';
    const description = f['Description'] || '';

    const newEntry = [
      `  {`,
      `    name: ${JSON.stringify(name)},`,
      `    url: ${JSON.stringify(url)},`,
      `    type: ${JSON.stringify(type)},`,
      `    club: ${JSON.stringify(club)},`,
      `    location: ${JSON.stringify(location)},`,
      `    description: ${JSON.stringify(description)},`,
      `  },`,
    ].join('\n');

    if (!sites.includes('];')) throw new Error('sites.js format unexpected — could not find closing ];');
    sites = sites.replace(/\];\s*$/, `\n${newEntry}\n];`);

    // Mark as Published so we don't process it again next run
    const updateRes = await fetch(`${baseUrl}/${record.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ fields: { Status: 'Published' } }),
    });
    if (!updateRes.ok) {
      console.warn(`Warning: failed to mark ${record.id} as Published: ${await updateRes.text()}`);
    }

    console.log(`✓ Added ${name} (${url})`);
  }

  writeFileSync('sites.js', sites);
})().catch(e => { console.error(e.message); process.exit(1); });
