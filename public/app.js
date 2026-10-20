"use strict";
const form = document.getElementById('feedback-form');
const kind = document.getElementById('kind');
const steps = document.getElementById('steps');
const result = document.getElementById('form-result');
const submit = form.querySelector('button[type="submit"]');

kind.addEventListener('change', () => {
  steps.required = kind.value === 'bug';
  document.getElementById('steps-note').textContent = steps.required ? '(required for bugs)' : '(optional)';
  result.textContent = '';
});
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
  result.textContent = 'Sending…';
  try {
    const res = await fetch('/api/feedback', { method: 'POST', body: data });
    const reply = await res.json().catch(() => ({}));
    if (res.ok && reply.ok) {
      form.reset();
      kind.dispatchEvent(new Event('change'));
      result.textContent = 'Thank you. Your report has been received.';
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
