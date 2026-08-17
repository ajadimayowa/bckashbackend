import { Injectable, Logger } from '@nestjs/common';

import { BankTransferPort } from '../interfaces/bank-transfer-port.interface';

/** *** TEMPORARY — SEE PHASE_8_NOTES.md AND BankTransferPort's OWN DOC COMMENT *** */
@Injectable()
export class StubBankTransferPort implements BankTransferPort {
  private readonly logger = new Logger(StubBankTransferPort.name);

  initiateTransfer(
    memberLoanAccountId: string,
    customerId: string,
    amountKobo: number,
  ): Promise<void> {
    this.logger.log(
      `[STUB] initiateTransfer memberLoanAccountId=${memberLoanAccountId} customerId=${customerId} amountKobo=${amountKobo} — no real transfer provider wired up yet`,
    );
    return Promise.resolve();
  }
}
