// 4xD feedback → Google Sheet + email.
//
// Paste this into the Sheet's Apps Script editor (Extensions → Apps Script).
// The Cloudflare Worker posts each saved report here; this adds a row to the
// "Reports" tab and emails the report to NOTIFY_TO with Reply-To set to the
// reporter, so replying goes straight to them.
//
// Script properties (Project Settings → Script properties):
//   TOKEN      created by setup(); must match the Worker's SHEETS_WEBHOOK_TOKEN
//   NOTIFY_TO  where report emails go, e.g. feedback@4xdplugin.com
//              (defaults to your own address until set)

const SHEET_NAME = 'Reports';
const COLUMNS = [
  'id', 'created_at', 'kind', 'version', 'os', 'daw', 'processor',
  'sample_rate', 'buffer_size', 'preset', 'description', 'steps', 'email',
];

// Run once from the editor. Creates the Reports tab and the shared token, and
// prints the token in the execution log for you to copy into Cloudflare.
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN')) {
    props.setProperty('TOKEN', (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''));
  }
  getSheet_();
  Logger.log('Add this to the Worker as the secret SHEETS_WEBHOOK_TOKEN:\n' + props.getProperty('TOKEN'));
}

function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply_({ ok: false, error: 'bad request' });
  }
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!token || data.token !== token) return reply_({ ok: false, error: 'unauthorised' });

  const report = data.report || {};
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    getSheet_().appendRow(COLUMNS.map(name => cell_(report[name])));
  } finally {
    lock.releaseLock();
  }
  notify_(report);
  return reply_({ ok: true });
}

function getSheet_() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = book.insertSheet(SHEET_NAME);
    sheet.appendRow(COLUMNS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Text that starts like a formula is stored as plain text, so a report can't
// run formulas in the Sheet.
function cell_(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
}

function notify_(r) {
  const to = PropertiesService.getScriptProperties().getProperty('NOTIFY_TO')
    || Session.getEffectiveUser().getEmail();
  const kind = r.kind === 'bug' ? 'Bug report' : 'Feedback';
  const subject = oneLine_(`[4xD] ${kind} #${r.id}: ${r.version} · ${r.os} · ${r.daw}`).slice(0, 180);
  const lines = [
    `${kind} #${r.id}, received ${r.created_at}`,
    '',
    `4xD version:  ${r.version || ''}`,
    `OS:           ${r.os || ''}`,
    `DAW:          ${r.daw || ''}`,
    `Processor:    ${r.processor || '-'}`,
    `Sample rate:  ${r.sample_rate || '-'}`,
    `Buffer size:  ${r.buffer_size || '-'}`,
    `Preset:       ${r.preset || '-'}`,
    `Email:        ${r.email || '(none given)'}`,
    '',
    'Description',
    '-----------',
    r.description || '',
    '',
    'Steps to reproduce',
    '------------------',
    r.steps || '-',
  ];
  if (!r.email) lines.push('', 'No email address was given, so replying will not reach the reporter.');
  const options = { name: '4xD feedback form' };
  if (r.email) options.replyTo = r.email;
  MailApp.sendEmail(to, subject, lines.join('\n'), options);
}

function oneLine_(text) {
  return String(text).replace(/[\r\n]+/g, ' ');
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
