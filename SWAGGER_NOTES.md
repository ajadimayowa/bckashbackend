# Swagger/OpenAPI Documentation — Notes

## What was added

- `@nestjs/swagger` wired up via `nest-cli.json`'s compiler plugin
  (`classValidatorShim` + `introspectComments`), so DTO schemas are inferred
  automatically from `class-validator` decorators and TSDoc comments instead
  of requiring manual `@ApiProperty()` on every field across ~20 DTOs.
- `SWAGGER_ENABLED` env var (`src/common/config/env.validation.ts`,
  `configuration.ts`, `.env.example`) — optional boolean. Explicit value
  always wins; otherwise **on** in every environment except `production`. A
  financial API's endpoint shapes/DTOs are worth not handing out publicly by
  default in prod.
- `src/main.ts`: `DocumentBuilder` + `SwaggerModule.setup('docs', ...)`,
  mounted outside the `/api` prefix (a docs UI isn't itself an API route). A
  single bearer-auth scheme named `access-token` is registered
  (`addBearerAuth(..., 'access-token')`) — this is what every
  `@ApiBearerAuth('access-token')` on protected controllers refers to.
  `persistAuthorization: true` so a pasted token survives a page refresh
  during manual testing.
- Every controller now carries `@ApiTags('<resource>')`; the 9 that require
  auth also carry `@ApiBearerAuth('access-token')` (`AuthController` and
  `HealthController` don't — their endpoints are public).
- `CustomerController.captureBiometric` (the one `multipart/form-data`
  endpoint, via `FileInterceptor('image')`) gets an explicit
  `@ApiConsumes('multipart/form-data')` + `@ApiBody({ schema: ... })` — the
  CLI plugin can't infer a file upload's shape from a plain
  `Express.Multer.File` parameter, so this one endpoint needed manual
  annotation. Everything else is fully auto-inferred.

## Verification

- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run
  build`, `npm test` (160/160), `npm run test:e2e` (1/1) — all clean.
- A temporary boot smoke test (`boot-smoke-test.mjs`, deleted after use, same
  pattern as every prior phase) booted the full compiled app against
  `mongodb-memory-server` with `SWAGGER_ENABLED=true` and confirmed:
  - `GET /docs` → 200, HTML contains `swagger-ui`.
  - `GET /docs-json` → 200, valid OpenAPI document, 40 paths.
  - `components.securitySchemes['access-token']` present (bearer/JWT).
  - Every one of the 40 paths carries the expected `@ApiTags` value on its
    operation(s) (spot-checked programmatically, not just visually).
  - The biometric upload endpoint's `requestBody` correctly shows a
    `multipart/form-data` schema with a required `image: string (binary)`
    field.

## Dependency vulnerability note

`@nestjs/swagger@11.4.6` pins `js-yaml@5.2.1`, which had 2 known
high-severity transitive vulnerabilities. Fixed via a top-level
`"overrides": { "js-yaml": "^5.2.2" }` in `package.json` rather than
downgrading `@nestjs/swagger` itself. `npm audit --omit=dev` → 0
vulnerabilities after the override.

## Known gap found (not fixed here — out of scope for "setup swagger docs")

**`RbacController` is missing `JwtAuthGuard`.** Every other protected
controller in the codebase applies `@UseGuards(JwtAuthGuard, StaffContextGuard,
CapabilityGuard)`; `RbacController` only has `@UseGuards(StaffContextGuard,
CapabilityGuard)` — no `JwtAuthGuard`. That means `request.user` is never
populated on a request to any `/api/rbac/*` route, so `StaffContextGuard`
401s on every call today. This fails closed (not a security hole — nothing is
under-protected), but it means the RBAC admin endpoints (list/update role
capabilities, update a staff member's module access) are currently
unreachable even by a legitimate SuperAdmin.

This was flagged directly in a code comment on `RbacController` rather than
fixed, because the correct fix is an architecture decision, not a docs
change: either register `JwtAuthGuard` globally via `APP_GUARD` (cleanest,
but changes auth behavior for every future controller by default), or import
`modules/identity`'s `JwtAuthGuard` directly into `platform/rbac`, which
would break the one-directional `platform → modules` dependency the rest of
the codebase deliberately maintains. Left for the user to decide.
