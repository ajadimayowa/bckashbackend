import { ConflictException } from '@nestjs/common';

/**
 * Thrown by BranchFundBalanceService.debit() when the atomic `$gte` guard
 * fails to match — i.e. the branch's available balance is (or became,
 * concurrently) less than the requested debit. 409, not 400: the request
 * itself is well-formed, but the branch's current state conflicts with it.
 */
export class InsufficientBranchFundsException extends ConflictException {
  constructor(
    public readonly branchId: string,
    public readonly requestedAmountKobo: number,
  ) {
    super(
      `Branch ${branchId} has insufficient available funds for a debit of ${requestedAmountKobo} kobo`,
    );
  }
}
