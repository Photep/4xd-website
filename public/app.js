"use strict";
const form = document.getElementById('feedback-form');
const kind = document.getElementById('kind');
const steps = document.getElementById('steps');
const result = document.getElementById('form-result');
const submit = form.querySelector('button[type="submit"]');
const files = document.getElementById('attachments');
const fileList = document.getElementById('attachment-list');

// Mirrors the server's checks so problems show before sending; the server
// checks file contents as well.
const MAX_FILES = 3, MAX_FILE_BYTES = 4 * 1024 * 1024, MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'txt', 'log', 'ips', 'crash', 'json'];

function size(bytes) {
  return bytes < 1024 * 1024 ? Math.max(1, Math.round(bytes / 1024)) + ' KB' : (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
function fileProblem() {
  const chosen = [...files.files];
  if (chosen.length > MAX_FILES) return `Attach up to ${MAX_FILES} files.`;
  for (const file of chosen) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!EXTENSIONS.includes(ext)) return `“${file.name}” isn’t a supported screenshot (PNG, JPEG, WebP) or text log.`;
    if (file.size === 0) return `“${file.name}” is empty.`;
    if (file.size > MAX_FILE_BYTES) return `“${file.name}” is larger than 4 MB.`;
  }
  if (chosen.reduce((sum, f) => sum + f.size, 0) > MAX_TOTAL_BYTES) return 'The attachments are larger than 8 MB in total.';
  return '';
}
function showFiles() {
  fileList.replaceChildren(...[...files.files].map(file => {
    const item = document.createElement('li');
    item.textContent = `${file.name} · ${size(file.size)}`;
    return item;
  }));
  const problem = fileProblem();
  files.setCustomValidity(problem);
  if (problem) { const item = document.createElement('li'); item.className = 'bad'; item.textContent = problem; fileList.append(item); }
}

kind.addEventListener('change', () => {
  steps.required = kind.value === 'bug';
  document.getElementById('steps-note').textContent = steps.required ? '(required for bugs)' : '(optional)';
  result.textContent = '';
});
files.addEventListener('change', showFiles);
form.addEventListener('input', () => { result.textContent = ''; });

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  if (!data.get('cf-turnstile-response')) {
    result.textContent = 'Please wait for the verification check to finish, then send again.';
    return;
  }
  submit.disabled = true;
  result.textContent = files.files.length ? 'Sending report and attachments…' : 'Sending…';
  try {
    const res = await fetch('/api/feedback', { method: 'POST', body: data });
    const reply = await res.json().catch(() => ({}));
    if (res.ok && reply.ok) {
      form.reset();
      showFiles();
      kind.dispatchEvent(new Event('change'));
      const number = reply.report ? ` (#${reply.report})` : '';
      result.textContent = reply.attachments && !reply.attachmentsSaved
        ? `Your report${number} has been received, but the attachments couldn’t be saved. Please email them to feedback@4xdplugin.com and mention the report number.`
        : `Thank you. Your report${number} has been received.`;
    } else {
      result.textContent = reply.error || 'The report could not be sent. Please try again.';
    }
  } catch {
    result.textContent = 'The report could not be sent. Check your connection and try again.';
  } finally {
    if (window.turnstile) window.turnstile.reset();
    submit.disabled = false;
  }
});
