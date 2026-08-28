import * as Joi from 'joi';

/**
 * Validates process.env at boot. Nest refuses to start if this fails, so a
 * misconfigured deploy (missing secret, malformed URI, etc.) fails fast
 * instead of surfacing as a runtime error deep inside a request.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),
  APP_BASE_URL: Joi.string().uri().required(),

  MONGO_URI: Joi.string().uri().required(),

  // Single-URL form — set this to switch to a cloud/managed Redis (e.g.
  // Render's internal `redis://<host>:<port>`, or a `rediss://user:pass@host:port`
  // TLS URL) without touching the discrete vars below. Whichever is set wins:
  // REDIS_URL present -> discrete REDIS_HOST/PORT/PASSWORD/TLS are ignored
  // entirely (see configuration.ts's resolveRedisConfig); absent -> falls
  // back to them exactly as before (local Redis, REDIS_HOST defaults to
  // 'localhost' in configuration.ts).
  // `.allow('')` — same "present but blank, e.g. an unset REDIS_URL= line in
  // .env.example/.env" reasoning as REDIS_PASSWORD below; an empty string
  // must NOT count as "REDIS_URL is set" for the REDIS_HOST fallback check
  // just below, so that check tests non-emptiness explicitly rather than
  // mere presence.
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .allow('')
    .optional(),
  REDIS_HOST: Joi.string().when('REDIS_URL', {
    is: Joi.string().min(1).required(),
    then: Joi.optional(),
    otherwise: Joi.required(),
  }),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').optional(),
  REDIS_TLS: Joi.boolean().default(false),

  JWT_ACCESS_SECRET: Joi.string().min(16).required(),
  JWT_ACCESS_EXPIRES_IN: Joi.string().default('4h'),
  JWT_REFRESH_SECRET: Joi.string().min(16).required(),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),

  PII_ENCRYPTION_KEY: Joi.string().min(32).required(),

  // Swagger/OpenAPI docs at /docs. Defaults to on in development, off in
  // production (a financial API's endpoint shapes/DTOs are worth not handing
  // out publicly by default) — explicitly override either way if needed.
  SWAGGER_ENABLED: Joi.boolean().optional(),

  // BVN verification (platform/integrations/bvn) — replaces the generic "NIBSS"
  // placeholder from Phase 1 now that the real provider contract is confirmed;
  // see PHASE_5_NOTES.md.
  BVN_QUERY_BASEURL: Joi.string().uri().required(),
  BVN_QUERY_AUTH_EMAIL: Joi.string().email().allow('').optional(),
  BVN_QUERY_AUTH_PASSWORD: Joi.string().allow('').optional(),
  // When true (or when auth credentials are absent), the mock adapter is used
  // instead of live calls — see bvn.module.ts.
  BVN_QUERY_USE_MOCK: Joi.boolean().default(false),

  AWS_REGION: Joi.string().required(),
  AWS_ACCESS_KEY_ID: Joi.string().allow('').optional(),
  AWS_SECRET_ACCESS_KEY: Joi.string().allow('').optional(),
  AWS_S3_BUCKET: Joi.string().required(),
  AWS_S3_SIGNED_URL_EXPIRES_IN: Joi.number().positive().default(900),
  // Mirrors BVN_QUERY_USE_MOCK — forces the in-memory S3 adapter even if
  // credentials above happen to be set.
  AWS_S3_USE_MOCK: Joi.boolean().default(false),
  AWS_REKOGNITION_FACE_MATCH_THRESHOLD: Joi.number().min(0).max(100).default(90),
  // Mirrors AWS_S3_USE_MOCK — see configuration.ts.
  AWS_REKOGNITION_USE_MOCK: Joi.boolean().default(false),

  BREVO_API_KEY: Joi.string().allow('').optional(),
  BREVO_SENDER_EMAIL: Joi.string().email().required(),
  BREVO_SENDER_NAME: Joi.string().required(),
  // Phase 11 (platform/integrations/brevo) — SMTP relay send. Optional: the
  // mock email adapter is used whenever these are absent (or BREVO_USE_MOCK
  // is explicitly true) — see configuration.ts/brevo.module.ts.
  MAIL_FROM: Joi.string().allow('').optional(),
  BREVO_SMTP_HOST: Joi.string().allow('').optional(),
  BREVO_SMTP_PORT: Joi.number().port().optional(),
  BREVO_SMTP_SECURE: Joi.boolean().optional(),
  BREVO_SMTP_LOGIN: Joi.string().allow('').optional(),
  BREVO_SMTP_KEY: Joi.string().allow('').optional(),
  BREVO_USE_MOCK: Joi.boolean().default(false),

  TERMII_API_KEY: Joi.string().allow('').optional(),
  TERMII_SENDER_ID: Joi.string().required(),
  TERMII_BASE_URL: Joi.string().uri().required(),
  // Mirrors BVN_QUERY_USE_MOCK — see configuration.ts.
  TERMII_USE_MOCK: Joi.boolean().default(false),

  // Phase 11 (modules/notifications) — BullMQ retry policy, named constants
  // rather than hardcoded magic numbers per the brief's own instruction.
  NOTIFICATION_MAX_ATTEMPTS: Joi.number().integer().positive().default(5),
  NOTIFICATION_BACKOFF_BASE_DELAY_MS: Joi.number().integer().positive().default(5000),

  // `npm run seed` bootstrap SuperAdmin — see src/database/seeders. Optional
  // at the app-boot/validation level (the normal server never needs these),
  // but the seeder script itself refuses to run without email/password set.
  SEED_SUPERADMIN_EMAIL: Joi.string().email().allow('').optional(),
  SEED_SUPERADMIN_PASSWORD: Joi.string().allow('').optional(),
  SEED_SUPERADMIN_FIRST_NAME: Joi.string().allow('').optional(),
  SEED_SUPERADMIN_LAST_NAME: Joi.string().allow('').optional(),
  SEED_SUPERADMIN_PHONE_NUMBER: Joi.string().allow('').optional(),
  // Initiator/Authorizer RBAC (see identity.enums.ts's StaffUserType doc
  // comment) — the bootstrap SuperAdmin's userType. Defaults to Authorizer
  // when unset (configuration.ts); Reviewer is deliberately not a valid
  // value here (see StaffService.resolveUserType — no longer assignable to
  // any of the four non-MARKETER roles going forward).
  SEED_SUPERADMIN_USER_TYPE: Joi.string().valid('Initiator', 'Authorizer').allow('').optional(),

  // Login OTP step (modules/identity/auth-otp.service.ts) — issued after a
  // correct email+password, required before an access/refresh token pair is
  // handed out. AUTH_OTP_DEFAULT_CODE, when set, replaces random generation
  // with this fixed value on every challenge issued — a dev/QA convenience
  // so a tester never has to check an inbox. *** NEVER SET THIS IN
  // PRODUCTION *** — every staff member's login OTP becomes this one
  // predictable value, which defeats the entire point of a second factor.
  AUTH_OTP_TTL_SECONDS: Joi.number().integer().positive().default(600),
  AUTH_OTP_MAX_ATTEMPTS: Joi.number().integer().positive().default(5),
  AUTH_OTP_DEFAULT_CODE: Joi.string().allow('').optional(),

  // Forgot-password step (modules/identity/password-reset.service.ts) —
  // issued when a staff member requests a reset code without logging in.
  // Same "dev/QA only, never in production" caveat as AUTH_OTP_DEFAULT_CODE
  // above applies to PASSWORD_RESET_DEFAULT_CODE.
  PASSWORD_RESET_TTL_SECONDS: Joi.number().integer().positive().default(600),
  PASSWORD_RESET_MAX_ATTEMPTS: Joi.number().integer().positive().default(5),
  PASSWORD_RESET_DEFAULT_CODE: Joi.string().allow('').optional(),

  // CustomerService.assertPhoneNumberAvailable — "no two customers may share
  // a phone number" is on by default; this exists purely so a downstream
  // BVN provider issue (e.g. an endpoint returning the same canned identity
  // for every BVN, in which case every verification after the first
  // legitimately collides) doesn't block onboarding entirely while that gets
  // sorted out. *** LEAVE THIS TRUE IN PRODUCTION *** — turning it off lets
  // multiple real customer records share one phone number.
  CUSTOMER_ENFORCE_UNIQUE_PHONE: Joi.boolean().default(true),
});
