export const EMAIL_ADAPTER = Symbol('EMAIL_ADAPTER');

export interface EmailSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Never throws — a transient SMTP hiccup returns `{ success: false, error }`
 * rather than an exception, so the calling BullMQ processor (not the
 * adapter) owns the retry/backoff decision. See PHASE_11_NOTES.md.
 */
export interface EmailAdapter {
  send(to: string, subject: string, htmlBody: string, textBody?: string): Promise<EmailSendResult>;
}
