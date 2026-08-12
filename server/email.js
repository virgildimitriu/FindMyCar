'use strict';

// Plain fetch against Resend's HTTP API — no SDK dependency needed, keeps
// the backend as dependency-free as the rest of it.
async function sendEmail(opts) {
  var apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not set');
  var res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.DIGEST_FROM_EMAIL || 'Find My Car <onboarding@resend.dev>',
      to: [opts.to],
      subject: opts.subject,
      html: opts.html
    })
  });
  if (!res.ok) {
    var text = await res.text().catch(function () { return ''; });
    throw new Error('Resend API error ' + res.status + ': ' + text);
  }
  return res.json();
}

module.exports = { sendEmail: sendEmail };
