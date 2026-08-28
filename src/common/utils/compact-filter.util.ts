/**
 * Strips undefined-valued keys from a Mongo filter object before handing it
 * to `.find()`/`.countDocuments()`/etc.
 *
 * Real bug this fixes: Mongoose does NOT treat `{ status: undefined }` the
 * same as `{}` ("no constraint on status"). It casts it into an actual
 * equality condition — `status` must literally be `undefined` — which never
 * matches a real document, so the query silently returns zero rows instead
 * of "no filter, return everything". This bites any `findAll(filter = {})`
 * built straight from optional `@Query(...)` controller params (`status`
 * absent from the URL comes through as `undefined`, not "key not present"),
 * e.g. `GET /loan-products` with no `?status=` returned `[]` even with real
 * ACTIVE products in the collection — confirmed against the real dev DB.
 *
 * Every `findAll`-style method whose filter object can contain an
 * undefined-valued key must run it through this first.
 */
export function compactFilter<T extends Record<string, unknown>>(filter: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(filter) as (keyof T)[]) {
    if (filter[key] !== undefined) {
      result[key] = filter[key];
    }
  }
  return result;
}
