// 4xD feedback → Google Sheet, Drive attachments and email.
//
// Paste this into the Sheet's Apps Script editor (Extensions → Apps Script).
// The Cloudflare Worker posts each saved report here; this saves any attached
// screenshots/logs to Drive, adds a row to the "Reports" tab and emails the
// report to NOTIFY_TO with Reply-To set to the reporter.
//
// Attachments are filed as:
//   4xD feedback attachments / 2026-10 / #14 · Bug report · 2026-10-22 / files
// and permanently deleted RETENTION_DAYS after the report by a daily trigger.
// Emails and the Sheet link to the report's folder; files are not attached to
// emails, so no copy outlives the retention period.
//
// Script properties (Project Settings → Script properties):
//   TOKEN                  created by setup(); must match the Worker's SHEETS_WEBHOOK_TOKEN
//   NOTIFY_TO              where report emails go (defaults to this account's address)
//   ATTACHMENTS_FOLDER_ID  created by setup()

const SHEET_NAME = 'Reports';
const COLUMNS = [
  'id', 'created_at', 'kind', 'version', 'os', 'daw', 'processor',
  'sample_rate', 'buffer_size', 'preset', 'description', 'steps', 'email', 'attachments',
];
const ROOT_FOLDER_NAME = '4xD feedback attachments';
const RETENTION_DAYS = 90;
// Must match the Worker's limits; checked again here.
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'text/plain'];
const MAX_FILES = 3, MAX_FILE_BYTES = 4 * 1024 * 1024;

// Run once from the editor (and again after updating this script). Creates the
// Reports tab, the shared token, the attachments folder and the daily clean-up
// trigger, then prints the token in the execution log for Cloudflare.
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN')) {
    props.setProperty('TOKEN', (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''));
  }
  getSheet_();
  const root = rootFolder_();
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'purgeOldAttachments')) {
    ScriptApp.newTrigger('purgeOldAttachments').timeBased().everyDays(1).atHour(3).create();
  }
  Logger.log('Attachments folder: ' + root.getUrl());
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
  let saved = { count: 0, url: '', names: [] }, attachmentError = '';
  const files = Array.isArray(data.attachments) ? data.attachments : [];
  if (files.length) {
    try { saved = saveAttachments_(report, files); }
    catch (err) { attachmentError = String(err); }
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const row = COLUMNS.map(name => cell_(report[name]));
    row[COLUMNS.indexOf('attachments')] = saved.count ? saved.url : (files.length ? 'not saved' : '');
    getSheet_().appendRow(row);
  } finally {
    lock.releaseLock();
  }
  notify_(report, saved, files.length);
  return reply_(attachmentError ? { ok: true, attachments: 0, error: attachmentError } : { ok: true, attachments: saved.count });
}

// Daily trigger: permanently delete report folders older than RETENTION_DAYS,
// then empty month folders.
function purgeOldAttachments() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const months = rootFolder_().getFolders();
  while (months.hasNext()) {
    const month = months.next();
    const reports = month.getFolders();
    while (reports.hasNext()) {
      const folder = reports.next();
      if (folder.getDateCreated().getTime() < cutoff) deletePermanently_(folder);
    }
    if (!month.getFolders().hasNext() && !month.getFiles().hasNext()) deletePermanently_(month);
  }
}

function saveAttachments_(report, files) {
  if (files.length > MAX_FILES) throw new Error('too many files');
  const created = String(report.created_at || new Date().toISOString());
  const month = folderNamed_(rootFolder_(), created.slice(0, 7));
  const kind = report.kind === 'bug' ? 'Bug report' : 'Feedback';
  const folder = month.createFolder(`#${report.id} · ${kind} · ${created.slice(0, 10)}`);
  const names = [];
  for (const file of files) {
    if (ALLOWED_TYPES.indexOf(file.type) < 0) throw new Error('unsupported type');
    const bytes = Utilities.base64Decode(String(file.data || ''));
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error('bad size');
    const name = safeName_(file.name);
    folder.createFile(Utilities.newBlob(bytes, file.type, name));
    names.push(name);
  }
  return { count: names.length, url: folder.getUrl(), names: names };
}

function rootFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('ATTACHMENTS_FOLDER_ID');
  if (id) {
    try {
      const folder = DriveApp.getFolderById(id);
      if (!folder.isTrashed()) return folder;
    } catch (err) { /* deleted: create a new one */ }
  }
  const folder = DriveApp.createFolder(ROOT_FOLDER_NAME);
  folder.setDescription('Screenshots and logs attached to 4xD feedback reports. Kept ' + RETENTION_DAYS + ' days.');
  props.setProperty('ATTACHMENTS_FOLDER_ID', folder.getId());
  return folder;
}

function folderNamed_(parent, name) {
  const found = parent.getFoldersByName(name);
  return found.hasNext() ? found.next() : parent.createFolder(name);
}

function deletePermanently_(item) {
  // DriveApp can only move to Trash; the Drive API deletes outright.
  const response = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + item.getId(), {
    method: 'delete',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() >= 300) item.setTrashed(true);
}

function safeName_(name) {
  const text = String(name || 'attachment').replace(/[^A-Za-z0-9 ._-]+/g, '-').trim().slice(0, 80);
  return text || 'attachment';
}

function getSheet_() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = book.insertSheet(SHEET_NAME);
    sheet.appendRow(COLUMNS);
    sheet.setFrozenRows(1);
  } else if (sheet.getLastColumn() < COLUMNS.length) {
    // Sheets created before attachments existed gain the new header.
    sheet.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS]);
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

function notify_(r, saved, attempted) {
  const to = PropertiesService.getScriptProperties().getProperty('NOTIFY_TO')
    || Session.getEffectiveUser().getEmail();
  const kind = r.kind === 'bug' ? 'Bug report' : 'Feedback';
  const clip = saved.count ? ' 📎' : '';
  const subject = oneLine_(`[4xD] ${kind} #${r.id}${clip}: ${r.version} · ${r.os} · ${r.daw}`).slice(0, 180);
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
  if (saved.count) {
    lines.push('', `Attachments (${saved.count}, deleted after ${RETENTION_DAYS} days)`, '-----------', saved.names.join('\n'), saved.url);
  } else if (attempted) {
    lines.push('', `Attachments: ${attempted} file(s) could not be saved. The reporter was asked to email them.`);
  }
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
