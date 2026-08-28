import { IsString, validate, ValidateNested } from 'class-validator';
import { Transform } from 'class-transformer';

import { parseJsonField, parseJsonFieldAsInstance } from './parse-json-field.util';

class NestedDto {
  @IsString()
  state!: string;

  @IsString()
  city!: string;
}

class HostDto {
  @Transform(parseJsonFieldAsInstance(NestedDto))
  @ValidateNested()
  address!: NestedDto;
}

describe('parseJsonField', () => {
  it('parses a JSON-encoded string', () => {
    expect(parseJsonField({ value: '{"a":1}' })).toEqual({ a: 1 });
  });

  it('passes a non-string value through untouched', () => {
    const value = { a: 1 };
    expect(parseJsonField({ value })).toBe(value);
  });

  it('throws BadRequestException for a malformed JSON string', () => {
    expect(() => parseJsonField({ value: '{not json' })).toThrow(/JSON-encoded/);
  });
});

describe('parseJsonFieldAsInstance', () => {
  const transform = parseJsonFieldAsInstance(NestedDto);

  it('parses a JSON-encoded string into a real NestedDto instance, not a plain object', () => {
    const result = transform({ value: '{"state":"Lagos","city":"Ikeja"}' });
    expect(result).toBeInstanceOf(NestedDto);
    expect(result).toEqual({ state: 'Lagos', city: 'Ikeja' });
  });

  it('instantiates a NestedDto even when the value already arrived as a plain object (a real application/json body)', () => {
    const result = transform({ value: { state: 'Lagos', city: 'Ikeja' } });
    expect(result).toBeInstanceOf(NestedDto);
  });

  it('passes undefined through untouched, so a sibling @IsOptional() still sees it as absent', () => {
    expect(transform({ value: undefined })).toBeUndefined();
  });

  it('passes null through untouched', () => {
    expect(transform({ value: null })).toBeNull();
  });

  /**
   * Regression test for a real bug: a bare `@Transform(parseJsonField)` on
   * a `@ValidateNested()` + `@Type()` field silently skips `@Type()`'s
   * instantiation, so a JSON-encoded-string nested value (the only way
   * multipart/form-data — or a defensive client — can send one) comes out
   * as a plain object. With this app's global `whitelist: true,
   * forbidNonWhitelisted: true`, class-validator then can't find any
   * decorated metadata on that plain object and rejects every one of its
   * legitimate properties as "property X should not exist" — exactly the
   * error a real onboarding request hit. `parseJsonFieldAsInstance` fixes
   * this by instantiating the target class itself; this test proves the
   * fixed field survives whitelist validation end-to-end.
   */
  it('survives whitelist + forbidNonWhitelisted validation when the value was sent as a JSON-encoded string', async () => {
    const host = new HostDto();
    (host as unknown as { address: unknown }).address = transform({
      value: '{"state":"Lagos","city":"Ikeja"}',
    });

    const errors = await validate(host, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toEqual([]);
  });
});
