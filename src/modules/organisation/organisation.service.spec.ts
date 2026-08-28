import { ConflictException, NotFoundException } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';

import { AuditModule } from '../../platform/audit/audit.module';
import { S3_ADAPTER } from '../../platform/integrations/s3/interfaces/s3-adapter.interface';
import { MockS3Service } from '../../platform/integrations/s3/mock-s3.service';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { CreateOrganisationDto } from './dto/create-organisation.dto';
import { OrganisationService } from './organisation.service';
import { Organisation, OrganisationSchema } from './schemas/organisation.schema';

describe('OrganisationService', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let service: OrganisationService;
  let mockS3: MockS3Service;
  const ACTOR_ID = new Types.ObjectId().toString();

  beforeAll(async () => {
    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([{ name: Organisation.name, schema: OrganisationSchema }]),
        AuditModule,
      ],
      providers: [
        OrganisationService,
        MockS3Service,
        { provide: S3_ADAPTER, useExisting: MockS3Service },
      ],
    }).compile();

    service = moduleRef.get(OrganisationService);
    mockS3 = moduleRef.get(MockS3Service);
  }, 60_000);

  afterEach(async () => {
    await mongo.clearAllCollections();
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  function createDto(overrides: Partial<CreateOrganisationDto> = {}): CreateOrganisationDto {
    const dto = new CreateOrganisationDto();
    dto.nameOfOrg = 'BCKash Cooperative';
    dto.address = '1 Cooperative Way, Lagos';
    dto.phoneNumbers = ['08012345678'];
    dto.organisationAccountDetails = [
      { bankName: 'First Bank', accountNumber: '1234567890', accountName: 'BCKash Cooperative' },
    ];
    dto.briefHistory = 'Founded to serve members with affordable credit.';
    dto.businessRegNumber = `RC-${Date.now()}`;
    return Object.assign(dto, overrides);
  }

  describe('create', () => {
    it('creates the organisation profile when none exists yet', async () => {
      const created = await service.create(createDto(), ACTOR_ID);

      expect(created.nameOfOrg).toBe('BCKash Cooperative');
      expect(created.cacDocKey).toBeNull();
      expect(created.createdBy.toString()).toBe(ACTOR_ID);
      expect(created.updatedBy).toBeNull();
      // Optional, absent here — both default to null.
      expect(created.cbnLicenseNumber).toBeNull();
      expect(created.contactEmail).toBeNull();
    });

    it('lowercases contactEmail and stores cbnLicenseNumber when supplied', async () => {
      const created = await service.create(
        createDto({ contactEmail: 'Info@BCKash.COM', cbnLicenseNumber: 'MFB/2019/0234' }),
        ACTOR_ID,
      );

      expect(created.contactEmail).toBe('info@bckash.com');
      expect(created.cbnLicenseNumber).toBe('MFB/2019/0234');
    });

    it('rejects creating a second organisation profile', async () => {
      await service.create(createDto(), ACTOR_ID);

      await expect(
        service.create(createDto({ businessRegNumber: `RC-${Date.now()}-2` }), ACTOR_ID),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('findOneOrThrow', () => {
    it('throws NotFoundException when no organisation profile exists yet', async () => {
      await expect(service.findOneOrThrow()).rejects.toThrow(NotFoundException);
    });

    it('returns the singleton once created', async () => {
      await service.create(createDto(), ACTOR_ID);

      const found = await service.findOneOrThrow();
      expect(found.nameOfOrg).toBe('BCKash Cooperative');
    });
  });

  describe('update', () => {
    it('throws NotFoundException when no organisation profile exists yet', async () => {
      await expect(service.update({ nameOfOrg: 'New Name' }, ACTOR_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('changes only the fields present in the DTO and records updatedBy', async () => {
      await service.create(createDto(), ACTOR_ID);
      const updater = new Types.ObjectId().toString();

      const updated = await service.update({ nameOfOrg: 'BCKash Cooperative Society' }, updater);

      expect(updated.nameOfOrg).toBe('BCKash Cooperative Society');
      expect(updated.address).toBe('1 Cooperative Way, Lagos'); // untouched
      expect(updated.updatedBy?.toString()).toBe(updater);
    });

    it('replaces the whole organisationAccountDetails array, not a merge', async () => {
      await service.create(createDto(), ACTOR_ID);

      const updated = await service.update(
        {
          organisationAccountDetails: [
            { bankName: 'GTBank', accountNumber: '0987654321', accountName: 'BCKash Coop' },
          ],
        },
        ACTOR_ID,
      );

      expect(updated.organisationAccountDetails).toHaveLength(1);
      expect(updated.organisationAccountDetails[0]?.bankName).toBe('GTBank');
    });
  });

  describe('remove', () => {
    it('throws NotFoundException when no organisation profile exists yet', async () => {
      await expect(service.remove(ACTOR_ID)).rejects.toThrow(NotFoundException);
    });

    it('deletes the singleton, and a new one can be created afterward', async () => {
      await service.create(createDto(), ACTOR_ID);

      await service.remove(ACTOR_ID);

      await expect(service.findOneOrThrow()).rejects.toThrow(NotFoundException);
      // Doesn't throw ConflictException anymore — the slate is clean.
      const recreated = await service.create(createDto({ businessRegNumber: `RC-${Date.now()}-new` }), ACTOR_ID);
      expect(recreated.nameOfOrg).toBe('BCKash Cooperative');
    });

    it('deletes the S3 CAC document along with the profile', async () => {
      await service.create(createDto(), ACTOR_ID);
      const withDoc = await service.uploadCacDoc(Buffer.from('pdf'), 'application/pdf', ACTOR_ID);
      const key = withDoc.cacDocKey!;
      expect(mockS3.has(key)).toBe(true);

      await service.remove(ACTOR_ID);

      expect(mockS3.has(key)).toBe(false);
    });
  });

  describe('CAC document', () => {
    it('getCacDocSignedUrl returns null when none has been uploaded', async () => {
      await service.create(createDto(), ACTOR_ID);

      const url = await service.getCacDocSignedUrl();
      expect(url).toBeNull();
    });

    it('throws NotFoundException for upload/signed-url before the organisation exists', async () => {
      await expect(
        service.uploadCacDoc(Buffer.from('pdf'), 'application/pdf', ACTOR_ID),
      ).rejects.toThrow(NotFoundException);
      await expect(service.getCacDocSignedUrl()).rejects.toThrow(NotFoundException);
    });

    it('uploads a CAC document, then a signed URL resolves for it', async () => {
      await service.create(createDto(), ACTOR_ID);

      const updated = await service.uploadCacDoc(
        Buffer.from('pdf-bytes'),
        'application/pdf',
        ACTOR_ID,
      );
      expect(updated.cacDocKey).not.toBeNull();
      expect(mockS3.has(updated.cacDocKey!)).toBe(true);

      const url = await service.getCacDocSignedUrl();
      expect(url).toContain(updated.cacDocKey!);
    });

    it('replacing an existing CAC document deletes the old S3 object', async () => {
      await service.create(createDto(), ACTOR_ID);
      const first = await service.uploadCacDoc(Buffer.from('v1'), 'application/pdf', ACTOR_ID);
      const firstKey = first.cacDocKey!;

      const second = await service.uploadCacDoc(Buffer.from('v2'), 'application/pdf', ACTOR_ID);

      expect(second.cacDocKey).not.toBe(firstKey);
      expect(mockS3.has(firstKey)).toBe(false);
      expect(mockS3.has(second.cacDocKey!)).toBe(true);
    });
  });
});
