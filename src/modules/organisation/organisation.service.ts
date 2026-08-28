import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { AuditService } from '../../platform/audit/audit.service';
import { buildOrganisationDocumentObjectKey } from '../../platform/integrations/s3/s3-key.util';
import {
  S3_ADAPTER,
  S3Adapter,
} from '../../platform/integrations/s3/interfaces/s3-adapter.interface';
import { CreateOrganisationDto } from './dto/create-organisation.dto';
import { UpdateOrganisationDto } from './dto/update-organisation.dto';
import { Organisation, OrganisationDocument } from './schemas/organisation.schema';

/**
 * Singleton profile — "the company's own details", not to be confused with
 * `DepartmentsService`/`UnitsService`/`BranchesService` (org *structure*).
 * Enforced here rather than via a unique index: a fixed-value unique index
 * (e.g. `{ singleton: 1 }` with a constant) works too, but a plain
 * count-then-create check reads more clearly and gives a friendlier error
 * message ("already exists, use update" vs. a raw duplicate-key error).
 */
@Injectable()
export class OrganisationService {
  constructor(
    @InjectModel(Organisation.name)
    private readonly organisationModel: Model<OrganisationDocument>,
    private readonly auditService: AuditService,
    @Inject(S3_ADAPTER) private readonly s3Adapter: S3Adapter,
  ) {}

  async create(dto: CreateOrganisationDto, createdBy: string): Promise<OrganisationDocument> {
    const existingCount = await this.organisationModel.countDocuments({}).exec();
    if (existingCount > 0) {
      throw new ConflictException(
        'An organisation profile already exists — use PATCH /organisation to update it instead.',
      );
    }

    const created = await this.organisationModel.create({
      nameOfOrg: dto.nameOfOrg,
      address: dto.address,
      phoneNumbers: dto.phoneNumbers,
      organisationAccountDetails: dto.organisationAccountDetails,
      briefHistory: dto.briefHistory,
      businessRegNumber: dto.businessRegNumber,
      cbnLicenseNumber: dto.cbnLicenseNumber ?? null,
      contactEmail: dto.contactEmail ? dto.contactEmail.toLowerCase() : null,
      cacDocKey: null,
      createdBy,
      updatedBy: null,
    });

    await this.auditService.record({
      actorId: createdBy,
      action: 'ORGANISATION_CREATED',
      entityType: 'ORGANISATION',
      entityId: created._id.toString(),
      after: { nameOfOrg: created.nameOfOrg, businessRegNumber: created.businessRegNumber },
    });

    return created;
  }

  /** Throws NotFoundException if the organisation hasn't been created yet — lets the frontend detect "setup not done" from a plain 404. */
  async findOneOrThrow(): Promise<OrganisationDocument> {
    const organisation = await this.organisationModel.findOne({}).exec();
    if (!organisation) {
      throw new NotFoundException(
        'No organisation profile exists yet — create one via POST /organisation.',
      );
    }
    return organisation;
  }

  async update(dto: UpdateOrganisationDto, updatedBy: string): Promise<OrganisationDocument> {
    const organisation = await this.findOneOrThrow();

    const before = {
      nameOfOrg: organisation.nameOfOrg,
      businessRegNumber: organisation.businessRegNumber,
    };

    if (dto.nameOfOrg !== undefined) {
      organisation.nameOfOrg = dto.nameOfOrg;
    }
    if (dto.address !== undefined) {
      organisation.address = dto.address;
    }
    if (dto.phoneNumbers !== undefined) {
      organisation.phoneNumbers = dto.phoneNumbers;
    }
    if (dto.organisationAccountDetails !== undefined) {
      organisation.organisationAccountDetails = dto.organisationAccountDetails;
    }
    if (dto.briefHistory !== undefined) {
      organisation.briefHistory = dto.briefHistory;
    }
    if (dto.businessRegNumber !== undefined) {
      organisation.businessRegNumber = dto.businessRegNumber;
    }
    if (dto.cbnLicenseNumber !== undefined) {
      organisation.cbnLicenseNumber = dto.cbnLicenseNumber;
    }
    if (dto.contactEmail !== undefined) {
      organisation.contactEmail = dto.contactEmail.toLowerCase();
    }
    organisation.updatedBy = new Types.ObjectId(updatedBy);
    await organisation.save();

    await this.auditService.record({
      actorId: updatedBy,
      action: 'ORGANISATION_UPDATED',
      entityType: 'ORGANISATION',
      entityId: organisation._id.toString(),
      before,
      after: {
        nameOfOrg: organisation.nameOfOrg,
        businessRegNumber: organisation.businessRegNumber,
      },
    });

    return organisation;
  }

  async uploadCacDoc(
    buffer: Buffer,
    contentType: string,
    uploadedBy: string,
  ): Promise<OrganisationDocument> {
    const organisation = await this.findOneOrThrow();

    const extension = contentType.split('/')[1] ?? 'pdf';
    const key = buildOrganisationDocumentObjectKey('cac-doc', extension);
    await this.s3Adapter.upload(key, buffer, contentType);

    const previousKey = organisation.cacDocKey;
    organisation.cacDocKey = key;
    await organisation.save();

    // The old object is orphaned S3 storage once replaced — best-effort
    // cleanup, same "don't fail the request over a cleanup step" posture
    // as elsewhere in this codebase's S3 usage.
    if (previousKey) {
      await this.s3Adapter.delete(previousKey).catch(() => undefined);
    }

    await this.auditService.record({
      actorId: uploadedBy,
      action: 'ORGANISATION_CAC_DOC_UPLOADED',
      entityType: 'ORGANISATION',
      entityId: organisation._id.toString(),
    });

    return organisation;
  }

  async getCacDocSignedUrl(expiresInSeconds?: number): Promise<string | null> {
    const organisation = await this.findOneOrThrow();
    if (!organisation.cacDocKey) {
      return null;
    }
    return this.s3Adapter.getSignedReadUrl(organisation.cacDocKey, expiresInSeconds);
  }

  /**
   * The only way to change `businessRegNumber` (unique) or start over on a
   * botched initial setup — the singleton rule means there's no "replace"
   * primitive otherwise. Best-effort S3 cleanup, same posture as the
   * upload-replace path above.
   */
  async remove(deletedBy: string): Promise<void> {
    const organisation = await this.findOneOrThrow();
    const cacDocKey = organisation.cacDocKey;

    await this.organisationModel.deleteOne({ _id: organisation._id }).exec();

    if (cacDocKey) {
      await this.s3Adapter.delete(cacDocKey).catch(() => undefined);
    }

    await this.auditService.record({
      actorId: deletedBy,
      action: 'ORGANISATION_DELETED',
      entityType: 'ORGANISATION',
      entityId: organisation._id.toString(),
      before: { nameOfOrg: organisation.nameOfOrg, businessRegNumber: organisation.businessRegNumber },
    });
  }
}
