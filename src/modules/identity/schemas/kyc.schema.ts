import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Gender, IdentificationType } from '../../../common/enums/identity.enums';

/**
 * Sub-document only — the identity-document particulars an onboarder types
 * in (date of birth, gender, ID type/number). Deliberately separate from
 * the `bvn*` field family already on Staff (bvnEncrypted/bvnVerified/
 * bvnVerifiedAt/bvnVerifiedBy, see that group's own doc comment): BVN has a
 * live verification workflow behind it (StaffService.verifyBvn calls an
 * external adapter and only then flips bvnVerified), so it stays its own
 * top-level field group rather than folding into this one — nothing here
 * is ever verified against a provider.
 */
@Schema({ _id: false })
export class Kyc {
  @Prop({ type: Date, default: null })
  dateOfBirth!: Date | null;

  @Prop({ type: String, enum: Gender, default: null })
  gender!: Gender | null;

  @Prop({ type: String, enum: IdentificationType, default: null })
  idType!: IdentificationType | null;

  @Prop({ type: String, default: null, trim: true })
  idNumber!: string | null;
}

export const KycSchema = SchemaFactory.createForClass(Kyc);
