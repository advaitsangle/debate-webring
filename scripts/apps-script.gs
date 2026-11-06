// ── Debate Webring: Google Apps Script ────────────────────────────────────
//
// SETUP (do this once):
//
// 1. Create a new Google Sheet, then go to Extensions → Apps Script
// 2. Paste this entire file, replacing any default code
// 3. Store your GitHub token as a script property:
//      Project Settings (gear icon) → Script Properties → Add property
//      Key: GITHUB_TOKEN   Value: <fine-grained token with Contents: read & write>
// 4. Deploy as a Web App:
//      Deploy → New Deployment → Web App
//      Execute as: Me  |  Who has access: Anyone
//      Copy the URL → paste it into join.html as APPS_SCRIPT_URL
// 5. Set up the installable trigger for approvals:
//      Triggers (clock icon, left sidebar) → Add Trigger
//      Function: onSheetEdit  |  Event source: From spreadsheet  |  Event type: On edit
//      (A simple onEdit trigger can't call MailApp or UrlFetchApp — installable one can)
// 6. Set up a daily trigger to warn you before the GitHub token expires:
//      Triggers → Add Trigger
//      Function: checkTokenExpiry  |  Event source: Time-driven  |  Day timer
//
// WORKFLOW:
//   Submission → sheet row + email to you
//   You change Status to "Approved" in the sheet → site added to sites.js + approval email sent
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_EMAIL = 'advaitsangle47@gmail.com';
const SHEET_NAME  = 'Submissions';
const REPO_OWNER  = 'advaitsangle';
const REPO_NAME   = 'debate-webring';
const WEBRING_URL = 'https://advaitsangle.github.io/debate-webring';

// Column indices (1-based)
const COL = { TIMESTAMP: 1, NAME: 2, EMAIL: 3, URL: 4, TYPE: 5, CLUB: 6, LOCATION: 7, DESCRIPTION: 8, STATUS: 9 };

// ── Receives form submissions ─────────────────────────────────────────────

function doPost(e) {
  try {
    const p = e.parameter;

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      sheet.appendRow(['Timestamp', 'Name', 'Email', 'URL', 'Type', 'Club', 'Location', 'Description', 'Status']);
      sheet.setFrozenRows(1);
    }

    sheet.appendRow([
      new Date(),
      p.name        || '',
      p.email       || '',
      p.url         || '',
      p.type        || 'website',
      p.club        || '',
      p.location    || '',
      p.description || '',
      'Pending',
    ]);

    MailApp.sendEmail({
      to: ADMIN_EMAIL,
      subject: `[Webring] New submission: ${p.name}`,
      body: [
        'New webring submission received.',
        '',
        `Name:        ${p.name}`,
        `Email:       ${p.email}`,
        `URL:         ${p.url}`,
        `Type:        ${p.type}`,
        `Club:        ${p.club || '—'}`,
        `Location:    ${p.location || '—'}`,
        '',
        'Description:',
        p.description || '—',
        '',
        'To approve: open the Google Sheet and change Status to "Approved".',
      ].join('\n'),
    });

    return ContentService
      .createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ── Watches for Status → "Approved" ──────────────────────────────────────
// This must be registered as an installable trigger (see setup step 5 above).
// Simple triggers cannot call MailApp or UrlFetchApp.

function onSheetEdit(e) {
  const sheet = e.source.getActiveSheet();
  if (sheet.getName() !== SHEET_NAME) return;

  const range = e.range;
  if (range.getColumn() !== COL.STATUS) return;
  if (range.getValue() !== 'Approved') return;

  const row = range.getRow();
  if (row <= 1) return;

  const values = sheet.getRange(row, 1, 1, 8).getValues()[0];
  const [, name, email, url, type, club, location, description] = values;

  try {
    addToGitHub_({ name, url, type, club, location, description });
  } catch (err) {
    range.setValue(`Error: ${err.message}`);
    MailApp.sendEmail({
      to: ADMIN_EMAIL,
      subject: `[Webring] Approval failed: ${name}`,
      body: `Could not add ${name} (${url}) to sites.js.\n\n${err.message}\n\n` +
            'Fix the problem (often an expired GITHUB_TOKEN), then set Status back to "Approved".',
    });
    return;
  }

  sendApprovalEmail_({ name, email, url });
  range.setValue('Published');
}

// ── Daily check: warn before the GitHub token expires ────────────────────
// Register as a time-driven trigger (see setup step 6 above).

const EXPIRY_WARNING_DAYS = 14;

function checkTokenExpiry() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  const res = UrlFetchApp.fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json' },
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  if (code !== 200) {
    warnToken_(`The GitHub token check failed with HTTP ${code}. The token has probably expired ` +
               'or been revoked. Approvals will not reach sites.js until it is replaced.');
    return;
  }

  // GitHub reports the expiry of personal access tokens in this response header.
  const headers = res.getAllHeaders();
  const key = Object.keys(headers).find(k => k.toLowerCase() === 'github-authentication-token-expiration');
  if (!key) return; // token has no expiry

  const expires = parseGitHubDate_(String(headers[key]));
  if (isNaN(expires)) {
    warnToken_(`Could not read the token expiry date from GitHub ("${headers[key]}"). Check it manually.`);
    return;
  }
  const daysLeft = Math.floor((expires - new Date()) / 86400000);
  if (daysLeft <= EXPIRY_WARNING_DAYS) {
    warnToken_(`The GitHub token expires in ${daysLeft} day(s), on ${headers[key]}.`);
  }
}

// Accepts "2026-12-01 00:00:00 -0500" or "2026-12-01 05:00:00 UTC".
function parseGitHubDate_(str) {
  const m = str.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (?:UTC|([+-]\d{2})(\d{2}))$/);
  if (!m) return new Date(NaN);
  const offset = m[3] ? `${m[3]}:${m[4]}` : 'Z';
  return new Date(`${m[1]}T${m[2]}${offset}`);
}

function warnToken_(message) {
  MailApp.sendEmail({
    to: ADMIN_EMAIL,
    subject: '[Webring] GitHub token needs attention',
    body: message + '\n\nCreate a new fine-grained token (Contents: read & write on ' +
          `${REPO_OWNER}/${REPO_NAME}) and update the GITHUB_TOKEN script property.`,
  });
}

// ── Append new site to sites.js via GitHub API ────────────────────────────

function addToGitHub_({ name, url, type, club, location, description }) {
  const token  = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/sites.js`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept':        'application/vnd.github.v3+json',
    'Content-Type':  'application/json',
  };

  const getRes  = UrlFetchApp.fetch(apiUrl, { headers, muteHttpExceptions: true });
  if (getRes.getResponseCode() !== 200) {
    throw new Error(`GitHub GET sites.js failed (HTTP ${getRes.getResponseCode()}): ${getRes.getContentText()}`);
  }
  const fileData = JSON.parse(getRes.getContentText());
  const sha      = fileData.sha;

  const currentContent = Utilities.newBlob(
    Utilities.base64Decode(fileData.content.replace(/\s/g, ''))
  ).getDataAsString();

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

  if (!currentContent.includes('];')) {
    throw new Error('sites.js format unexpected — could not find closing ];');
  }

  const updatedContent = currentContent.replace(/\];\s*$/, `\n${newEntry}\n];`);
  const encoded = Utilities.base64Encode(Utilities.newBlob(updatedContent, 'UTF-8').getBytes());

  const putRes = UrlFetchApp.fetch(apiUrl, {
    method: 'put',
    headers,
    payload: JSON.stringify({
      message: `add ${name} to the webring`,
      content: encoded,
      sha,
      branch: 'main',
    }),
    muteHttpExceptions: true,
  });

  const putCode = putRes.getResponseCode();
  if (putCode !== 200 && putCode !== 201) {
    throw new Error(`GitHub update of sites.js failed (HTTP ${putCode}): ${putRes.getContentText()}`);
  }
}

// ── Send approval email to submitter ─────────────────────────────────────

function sendApprovalEmail_({ name, email, url }) {
  MailApp.sendEmail({
    to: email,
    subject: `You're in the debate webring!`,
    body: [
      `Hi ${name},`,
      '',
      `Your site has been approved and added to the debate webring. Welcome to the ring!`,
      '',
      `Visit the webring to find your entry and copy your navigation links:`,
      `${WEBRING_URL}`,
      '',
      `Your "prev" and "next" links will be shown on your entry card. You can add them`,
      `anywhere on your site — footer, about page, YouTube description, wherever.`,
      '',
      '— Debate Webring',
    ].join('\n'),
  });
}
