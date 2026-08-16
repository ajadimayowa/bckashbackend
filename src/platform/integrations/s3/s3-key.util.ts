import { randomUUID } from 'node:crypto';

/**
 * `kyc/{customerId}/{documentType}/{uuid}.{ext}` — predictable and
 * namespaced by customer + document type, so bucket-level lifecycle/retention
 * policies can be applied by prefix later (e.g. auto-expire `kyc/*` after N
 * years) without touching application code.
 */
export function buildKycObjectKey(
  customerId: string,
  documentType: string,
  fileExtension: string,
): string {
  const ext = fileExtension.replace(/^\./, '').toLowerCase();
  return `kyc/${customerId}/${documentType}/${randomUUID()}.${ext}`;
}
