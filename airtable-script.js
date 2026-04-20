// ── Debate Webring: Airtable Automation Script ────────────────────────────
//
// Paste this into an Airtable Automation "Run script" action.
// Trigger: "When a record's field changes" → Status field → changes to "Approved"
//
// Required input variables (set these in the automation's input config):
//   name        → {Name} field
//   url         → {URL} field
//   type        → {Content type} field
//   club        → {Club / organisation} field
//   location    → {Location} field
//   description → {Description} field
//
// Required secret (set in automation settings → "Set input variables"):
//   GITHUB_TOKEN → a GitHub personal access token with repo write access
//                  (Settings → Developer settings → Personal access tokens → Fine-grained
//                   → Contents: read & write)
//
// ─────────────────────────────────────────────────────────────────────────────

const cfg = input.config();

const {
  name,
  url,
  type,
  club,
  location,
  description,
  GITHUB_TOKEN,
} = cfg;

const REPO_OWNER = 'advaitsangle';
const REPO_NAME  = 'debate-webring';
const FILE_PATH  = 'sites.js';
const BRANCH     = 'main';
const API_URL    = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`;

const headers = {
  Authorization:  `Bearer ${GITHUB_TOKEN}`,
  Accept:         'application/vnd.github.v3+json',
  'Content-Type': 'application/json',
};

// Step 1: Fetch current sites.js from GitHub
const getRes = await fetch(API_URL, { headers });
if (!getRes.ok) throw new Error(`GitHub GET failed: ${getRes.status} ${await getRes.text()}`);

const fileData = await getRes.json();
const sha = fileData.sha;

// GitHub returns content as base64 with line breaks — strip them before decoding
const currentContent = atob(fileData.content.replace(/\s/g, ''));

// Step 2: Build new entry (JSON.stringify handles escaping of any special chars)
const newEntry = [
  `  {`,
  `    name: ${JSON.stringify(name)},`,
  `    url: ${JSON.stringify(url)},`,
  `    type: ${JSON.stringify(type || 'website')},`,
  `    club: ${JSON.stringify(club || '')},`,
  `    location: ${JSON.stringify(location || '')},`,
  `    description: ${JSON.stringify(description || '')},`,
  `  },`,
].join('\n');

// Step 3: Insert before the closing ]; of the SITES array
if (!currentContent.includes('];')) {
  throw new Error('sites.js format unexpected — could not find closing ];');
}
const updatedContent = currentContent.replace(/\];\s*$/, `\n${newEntry}\n];`);

// Step 4: Base64-encode and commit
// encodeURIComponent + unescape handles non-ASCII characters safely
const encoded = btoa(unescape(encodeURIComponent(updatedContent)));

const putRes = await fetch(API_URL, {
  method: 'PUT',
  headers,
  body: JSON.stringify({
    message: `add ${name} to the webring`,
    content: encoded,
    sha,
    branch: BRANCH,
  }),
});

if (!putRes.ok) {
  const err = await putRes.text();
  throw new Error(`GitHub PUT failed: ${putRes.status} ${err}`);
}

console.log(`✓ Successfully added ${name} (${url}) to sites.js`);
