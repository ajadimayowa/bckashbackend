import { BadRequestException } from '@nestjs/common';
import { ClassConstructor, plainToInstance } from 'class-transformer';

/**
 * class-transformer `@Transform` callback for a DTO field that must survive
 * *both* `application/json` bodies (value already an object/array) and
 * `multipart/form-data` bodies (every field arrives as a string — a nested
 * object or array has to be sent JSON-encoded, e.g.
 * `formData.append('kyc', JSON.stringify({...}))`). No-ops for anything
 * that isn't a string, so a real JSON request is never touched.
 *
 * Only safe to pair with `@Type(() => SomeDto)` + `@ValidateNested()` when
 * the value is a *plain, already-typed* JSON body (no encoded string to
 * unwrap) — see `parseJsonFieldAsInstance` below for the nested-DTO case,
 * which this alone does not handle correctly.
 */
export function parseJsonField({ value }: { value: unknown }): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    throw new BadRequestException('Expected a JSON-encoded value for this field');
  }
}

/**
 * Same JSON-string tolerance as `parseJsonField`, but for a field validated
 * with `@ValidateNested()` against a nested DTO class (`residentialAddress`,
 * `kyc`, `nextOfKin`, `reference`, ...).
 *
 * A bare `@Transform(parseJsonField)` on such a field is a real, previously-
 * shipped bug: once a `@Transform` callback is declared on a property,
 * class-transformer uses *only* that callback's return value for the
 * property — it does NOT also apply the sibling `@Type(() => SomeDto)`
 * decorator's usual "instantiate as this class" step. So a JSON-encoded
 * string (multipart/form-data's only way to send a nested object, or any
 * client that JSON.stringifies nested fields defensively) gets parsed back
 * into a *plain* object, not a `SomeDto` instance. `@ValidateNested()` then
 * recurses into that plain object, and — with the app's global
 * `whitelist: true, forbidNonWhitelisted: true` — class-validator can't
 * find any decorated metadata on a bare `Object`, so it rejects every one
 * of the nested DTO's own legitimate properties as
 * `"<field>.property <x> should not exist"`. A request built from a real
 * object (`application/json`, fields not pre-stringified) never hit this,
 * which is why it went unnoticed until a client sent the JSON-encoded-string
 * form the multipart path was actually built for.
 *
 * Fix: explicitly instantiate the target class here, after parsing —
 * `@Type()` becomes redundant once this runs and should be dropped from the
 * property to avoid implying it's still doing something.
 */
export function parseJsonFieldAsInstance<T>(
  targetClass: ClassConstructor<T>,
): (params: { value: unknown }) => unknown {
  return ({ value }: { value: unknown }): unknown => {
    const parsed = parseJsonField({ value });
    // undefined/null pass through untouched — plainToInstance would
    // otherwise happily "instantiate" an all-undefined instance out of
    // nothing, which would defeat a sibling @IsOptional() (no longer
    // literally undefined, so no longer treated as absent).
    if (parsed === undefined || parsed === null) {
      return parsed;
    }
    return plainToInstance(targetClass, parsed);
  };
}
