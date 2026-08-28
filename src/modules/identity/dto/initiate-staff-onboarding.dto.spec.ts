import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';

import { InitiateStaffOnboardingDto } from './initiate-staff-onboarding.dto';

/**
 * Same ValidationPipe options as main.ts's global pipe — the bug this
 * guards against only shows up with `whitelist: true` +
 * `forbidNonWhitelisted: true` in the mix.
 */
function buildPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });
}

const metadata: ArgumentMetadata = { type: 'body', metatype: InitiateStaffOnboardingDto };

const validBody = {
  role: 'MARKETER',
  firstName: 'John',
  lastName: 'Doe',
  email: 'john.doe@example.com',
  phoneNumber: '08012345678',
  userType: 'Initiator',
  departmentId: '507f1f77bcf86cd799439011',
  unitId: '507f1f77bcf86cd799439011',
  branchId: '507f1f77bcf86cd799439011',
  startDate: '2024-01-01',
  residentialAddress: { state: 'Lagos', city: 'Ikeja', street: '1 Main St' },
  kyc: { dateOfBirth: '1990-01-01', gender: 'Male', idType: 'NIN', idNumber: '12345678901' },
  nextOfKin: {
    name: 'Jane Doe',
    relationship: 'Sister',
    phoneNumber: '08012345678',
    address: '2 Main St',
  },
  reference: {
    name: 'Bob Smith',
    relationship: 'Friend',
    phoneNumber: '08012345678',
    address: '3 Main St',
  },
};

describe('InitiateStaffOnboardingDto — nested-field validation', () => {
  it('accepts real (application/json) nested objects', async () => {
    const result = (await buildPipe().transform(
      { ...validBody, moduleAccess: ['LOANS'] },
      metadata,
    )) as InitiateStaffOnboardingDto;
    expect(result.residentialAddress).toEqual(validBody.residentialAddress);
    expect(result.kyc).toEqual(validBody.kyc);
  });

  /**
   * Regression test for a real, user-reported bug: onboarding failed with
   * "residentialAddress.property state should not exist" (and the same for
   * every other field on kyc/nextOfKin/reference) whenever the client sent
   * those fields JSON-encoded as strings — the documented, required
   * convention for multipart/form-data (see parseJsonField's own doc
   * comment: "formData.append('kyc', JSON.stringify({...}))"), and also
   * what a defensive JSON client can do without realizing it matters. Root
   * cause: a bare `@Transform(parseJsonField)` alongside `@Type()` +
   * `@ValidateNested()` skipped `@Type()`'s instantiation, leaving a plain
   * object that whitelist validation rejected wholesale. Fixed via
   * `parseJsonFieldAsInstance` — see parse-json-field.util.ts.
   */
  it('accepts the same nested objects JSON-encoded as strings (the multipart/form-data convention)', async () => {
    const body = {
      ...validBody,
      moduleAccess: JSON.stringify(['LOANS']),
      residentialAddress: JSON.stringify(validBody.residentialAddress),
      kyc: JSON.stringify(validBody.kyc),
      nextOfKin: JSON.stringify(validBody.nextOfKin),
      reference: JSON.stringify(validBody.reference),
    };

    const result = (await buildPipe().transform(body, metadata)) as InitiateStaffOnboardingDto;
    expect(result.residentialAddress).toEqual(validBody.residentialAddress);
    expect(result.kyc).toEqual(validBody.kyc);
    expect(result.nextOfKin).toEqual(validBody.nextOfKin);
    expect(result.reference).toEqual(validBody.reference);
  });

  it('still rejects a JSON-encoded nested object that is missing a required field', async () => {
    const body = {
      ...validBody,
      moduleAccess: JSON.stringify(['LOANS']),
      residentialAddress: JSON.stringify({ state: 'Lagos', city: 'Ikeja' }), // missing street
    };

    // Confirms the fix didn't accidentally turn off real validation on the
    // nested DTO's own fields — .message alone is just the generic "Bad
    // Request Exception" text; the per-field errors live in the response body.
    let caught: BadRequestException | undefined;
    try {
      await buildPipe().transform(body, metadata);
    } catch (error) {
      caught = error as BadRequestException;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    const response = caught?.getResponse() as { message: string[] };
    expect(response.message.some((message) => /street/.test(message))).toBe(true);
  });
});
