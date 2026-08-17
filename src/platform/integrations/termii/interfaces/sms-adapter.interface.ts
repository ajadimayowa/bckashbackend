export const SMS_ADAPTER = Symbol('SMS_ADAPTER');

export interface SmsSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/** Same non-throwing contract as EmailAdapter — see that interface's own doc comment. */
export interface SmsAdapter {
  send(toPhoneNumber: string, message: string): Promise<SmsSendResult>;
}
