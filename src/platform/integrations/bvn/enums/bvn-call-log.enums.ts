/** AUTH_LOGIN is not one of the three confirmed provider endpoints — added so the
 *  internal auth login is reconciliation-visible too, per the phase's test requirements. */
export enum BvnCallStep {
  AUTH_LOGIN = 'AUTH_LOGIN',
  CONSENT_INITIATE = 'CONSENT_INITIATE',
  CONSENT_CONFIRM = 'CONSENT_CONFIRM',
  DIRECT_VERIFY = 'DIRECT_VERIFY',
}

export enum BvnCallEntityType {
  CUSTOMER = 'CUSTOMER',
  STAFF = 'STAFF',
}
