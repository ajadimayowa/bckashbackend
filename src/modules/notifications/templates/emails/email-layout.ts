/**
 * Shared branded HTML shell every transactional email renders through —
 * BCKash Cooperative's colors/wordmark live here, once, so every individual
 * template (loan-raised.email.ts etc.) only has to supply its own content.
 *
 * Deliberately table-based layout + inline styles throughout, no external
 * stylesheet/webfont/`<style>` block — most email clients (Outlook desktop
 * especially) strip or ignore all three, so inline styles on a table-based
 * skeleton is still the only broadly-reliable way to lay out HTML email.
 */

const BRAND_NAME = 'BCKash Cooperative';
// Company primary color — every email header (and the amount-callout
// accent, which reuses it) renders in this one place, so every template in
// ./emails/ picks it up automatically.
const BRAND_PRIMARY_COLOR = '#00481F';
const BRAND_TEXT_COLOR = '#1A1A1A';
const BRAND_MUTED_COLOR = '#6B7280';
const BRAND_BACKGROUND_COLOR = '#F3F4F6';
const BRAND_CARD_COLOR = '#FFFFFF';

export interface EmailLayoutOptions {
  /** Rendered as the card's heading — usually the same text as the email subject, kept short. */
  heading: string;
  /** Pre-rendered inner HTML (paragraphs, etc.) — callers build this, the layout only wraps it. */
  bodyHtml: string;
}

export function renderEmailLayout({ heading, bodyHtml }: EmailLayoutOptions): string {
  const year = new Date().getFullYear();
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(heading)}</title>
  </head>
  <body style="margin:0; padding:0; background-color:${BRAND_BACKGROUND_COLOR}; font-family:Arial, Helvetica, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND_BACKGROUND_COLOR}; padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px; width:100%; background-color:${BRAND_CARD_COLOR}; border-radius:8px; overflow:hidden;">
            <tr>
              <td style="background-color:${BRAND_PRIMARY_COLOR}; padding:20px 32px;">
                <span style="color:#FFFFFF; font-size:20px; font-weight:bold; letter-spacing:0.3px;">${BRAND_NAME}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 16px; font-size:18px; color:${BRAND_TEXT_COLOR};">${escapeHtml(heading)}</h1>
                <div style="font-size:14px; line-height:1.6; color:${BRAND_TEXT_COLOR};">
                  ${bodyHtml}
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px; border-top:1px solid #E5E7EB;">
                <p style="margin:0; font-size:12px; color:${BRAND_MUTED_COLOR};">
                  This is an automated message from ${BRAND_NAME}. Please do not reply directly to this email.
                </p>
                <p style="margin:8px 0 0; font-size:12px; color:${BRAND_MUTED_COLOR};">
                  &copy; ${year} ${BRAND_NAME}. All rights reserved.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** Payload strings can come from user-entered free text (reasons, notes) — escape before interpolating into HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A single labeled paragraph — the common building block most templates below use. */
export function paragraph(text: string): string {
  return `<p style="margin:0 0 12px;">${text}</p>`;
}

/** A prominent amount/figure callout — used for loan/repayment/penalty amounts. */
export function amountCallout(label: string, amountDisplay: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0; width:100%; background-color:#F3F4F6; border-radius:6px;">
    <tr>
      <td style="padding:12px 16px;">
        <div style="font-size:12px; color:${BRAND_MUTED_COLOR}; text-transform:uppercase; letter-spacing:0.4px;">${escapeHtml(label)}</div>
        <div style="font-size:22px; font-weight:bold; color:${BRAND_PRIMARY_COLOR};">${amountDisplay}</div>
      </td>
    </tr>
  </table>`;
}
