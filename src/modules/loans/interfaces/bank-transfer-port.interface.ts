export const BANK_TRANSFER_PORT = Symbol('BANK_TRANSFER_PORT');

/**
 * *** NOT part of the brief's explicit port list — added because §6 requires
 * "for TRANSFER channel members: call the (stubbed, per the earlier build
 * brief) bank transfer adapter interface — flag clearly that this needs a
 * real provider decision." No bank-transfer provider has been chosen yet
 * (`platform/integrations/nibss/` is an empty placeholder — Phase 5 ended up
 * using it for BVN, not bank transfer, see that folder's README). This port
 * exists purely so the disbursement flow has a concrete call site to point at
 * once a provider is chosen; it is NOT wired to any real integration and has
 * no rebinding phase assigned yet. See PHASE_8_NOTES.md. ***
 */
export interface BankTransferPort {
  initiateTransfer(
    memberLoanAccountId: string,
    customerId: string,
    amountKobo: number,
  ): Promise<void>;
}
