import { StaffUserType } from '../enums/identity.enums';

/**
 * Typed, namespaced configuration factory consumed via ConfigService.get<T>('namespace').
 * Keeping this separate from env.validation.ts means the validation shape (raw env vars)
 * and the shape the app actually consumes can evolve independently.
 */
export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  baseUrl: string;
  swaggerEnabled: boolean;
}

export interface MongoConfig {
  uri: string;
}

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  tls: boolean;
}

/**
 * REDIS_URL (cloud/managed Redis, e.g. Render's internal
 * `redis://<host>:<port>` or a `rediss://user:pass@host:port` TLS one) wins
 * outright when set — the discrete REDIS_HOST/PORT/PASSWORD/TLS vars are
 * only ever a fallback for local dev, never merged with it. `rediss:`
 * implies TLS automatically; REDIS_TLS can still force it on for a plain
 * `redis:` URL that needs it (some managed providers do), but never off for
 * a `rediss:` one — that would silently drop encryption the URL itself asked for.
 */
function resolveRedisConfig(): RedisConfig {
  const url = process.env.REDIS_URL;
  if (url) {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port, 10) : 6379,
      password: parsed.password || undefined,
      tls: parsed.protocol === 'rediss:' || process.env.REDIS_TLS === 'true',
    };
  }
  return {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === 'true',
  };
}

export interface JwtConfig {
  accessSecret: string;
  accessExpiresIn: string;
  refreshSecret: string;
  refreshExpiresIn: string;
}

export interface EncryptionConfig {
  piiKey: string;
}

export interface BvnConfig {
  baseUrl: string;
  authEmail?: string;
  authPassword?: string;
  useMock: boolean;
}

export interface AwsConfig {
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  s3: {
    bucket: string;
    signedUrlExpiresInSeconds: number;
    useMock: boolean;
  };
  rekognition: {
    faceMatchThreshold: number;
    useMock: boolean;
  };
}

/**
 * *** RECONCILED IN PHASE 11 — SEE PHASE_11_NOTES.md ***
 * `apiKey`/`senderEmail`/`senderName` were Phase 1/2 placeholder fields
 * (unused until now). Phase 11's brief calls for SMTP-based sending via
 * Nodemailer specifically — this codebase's `.env` already had the SMTP
 * fields prepared (commented out, real-looking values matching Brevo's own
 * "your API key doubles as the SMTP password" convention), so `smtp` was
 * added rather than introducing a second, differently-named config surface.
 * `senderEmail`/`senderName` remain the From header source (`mailFrom`
 * optionally overrides with a full "Name <email>" string, per the brief's
 * own MAIL_FROM convention — new, since no such override existed before).
 */
export interface BrevoConfig {
  apiKey?: string;
  senderEmail: string;
  senderName: string;
  mailFrom?: string;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    login?: string;
    key?: string;
  };
  useMock: boolean;
}

export interface TermiiConfig {
  apiKey?: string;
  senderId: string;
  baseUrl: string;
  useMock: boolean;
}

export interface NotificationConfig {
  maxAttempts: number;
  backoffBaseDelayMs: number;
}

/**
 * Bootstrap SuperAdmin credentials for `npm run seed` — see
 * src/database/seeders. `email`/`password` deliberately have no default:
 * the seeder fails loudly rather than silently creating a predictable
 * SuperAdmin account with a guessable password.
 */
export interface SeedConfig {
  superAdminEmail?: string;
  superAdminPassword?: string;
  superAdminFirstName: string;
  superAdminLastName: string;
  superAdminPhoneNumber: string;
  /**
   * Initiator/Authorizer RBAC (see StaffUserType's own doc comment,
   * identity.enums.ts) — SEED_SUPERADMIN_USER_TYPE, defaulting to Authorizer
   * when unset. Authorizer is the sensible bootstrap default: the very
   * first real org buildout (creating the first Admin/Manager/Approver
   * accounts) happens via POST /staff/direct, which is gated purely by
   * STAFF_CREATE_DIRECT_CAPABILITY (SuperAdmin-only) and never touches the
   * workflow engine's initiate() at all — so an Authorizer-only bootstrap
   * SuperAdmin can still do that, plus approve/authorize everything else,
   * without ever needing to self-initiate a workflow request (which the
   * maker-never-checks-own-work rule would block them from approving
   * anyway). Reviewer is deliberately not a valid value — see
   * env.validation.ts.
   */
  superAdminUserType: StaffUserType;
}

/**
 * Login OTP step config — see AuthOtpService. `defaultCode`, when set,
 * replaces random 6-digit generation with this fixed value on every
 * challenge issued (dev/QA convenience only — see env.validation.ts's own
 * warning comment, repeated here: never set in production).
 */
export interface AuthOtpConfig {
  ttlSeconds: number;
  maxAttempts: number;
  defaultCode?: string;
}

/**
 * Forgot-password step config — see PasswordResetService. Deliberately its
 * own config block rather than reusing `AuthOtpConfig` — the two flows are
 * issued/verified independently (a staff member could have both a live
 * login OTP and a live password-reset code at once) and may need different
 * tuning in production, even though the shape is identical today.
 * `defaultCode` carries the same "*** NEVER SET IN PRODUCTION ***" dev/QA
 * caveat as `AuthOtpConfig.defaultCode` — see env.validation.ts.
 */
export interface PasswordResetConfig {
  ttlSeconds: number;
  maxAttempts: number;
  defaultCode?: string;
}

/**
 * CustomerService.assertPhoneNumberAvailable's on/off switch — see
 * env.validation.ts's own doc comment on CUSTOMER_ENFORCE_UNIQUE_PHONE for
 * why this exists and why it defaults to (and should stay) true.
 */
export interface CustomersConfig {
  enforceUniquePhoneNumber: boolean;
}

export interface RootConfig {
  app: AppConfig;
  mongo: MongoConfig;
  redis: RedisConfig;
  jwt: JwtConfig;
  encryption: EncryptionConfig;
  bvn: BvnConfig;
  aws: AwsConfig;
  brevo: BrevoConfig;
  termii: TermiiConfig;
  notification: NotificationConfig;
  seed: SeedConfig;
  authOtp: AuthOtpConfig;
  passwordReset: PasswordResetConfig;
  customers: CustomersConfig;
}

/** See SeedConfig.superAdminUserType's own doc comment. env.validation.ts already restricts the raw value to these two strings (or empty/unset), so an unexpected value here only happens if that validation is ever bypassed — checked again anyway per this codebase's "service must not trust a caller that bypasses the DTO/validation layer" convention. */
function parseSeedSuperAdminUserType(value: string | undefined): StaffUserType {
  const normalized = value?.trim();
  if (!normalized) {
    return StaffUserType.AUTHORIZER;
  }
  if (normalized === StaffUserType.INITIATOR || normalized === StaffUserType.AUTHORIZER) {
    return normalized;
  }
  throw new Error(
    `SEED_SUPERADMIN_USER_TYPE must be "${StaffUserType.INITIATOR}" or "${StaffUserType.AUTHORIZER}" (got "${value}") — Reviewer is not assignable to SUPERADMIN.`,
  );
}

export default (): RootConfig => {
  const nodeEnv = (process.env.NODE_ENV as AppConfig['nodeEnv']) ?? 'development';
  return {
    app: {
      nodeEnv,
      port: parseInt(process.env.PORT ?? '3000', 10),
      baseUrl: process.env.APP_BASE_URL ?? 'http://localhost:3000',
      // Explicit SWAGGER_ENABLED always wins; otherwise on everywhere except production.
      swaggerEnabled:
        process.env.SWAGGER_ENABLED !== undefined
          ? process.env.SWAGGER_ENABLED === 'true'
          : nodeEnv !== 'production',
    },
    mongo: {
      uri: process.env.MONGO_URI ?? '',
    },
    redis: resolveRedisConfig(),
    jwt: {
      accessSecret: process.env.JWT_ACCESS_SECRET ?? '',
      accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '4h',
      refreshSecret: process.env.JWT_REFRESH_SECRET ?? '',
      refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d',
    },
    encryption: {
      piiKey: process.env.PII_ENCRYPTION_KEY ?? '',
    },
    bvn: {
      baseUrl: process.env.BVN_QUERY_BASEURL ?? '',
      authEmail: process.env.BVN_QUERY_AUTH_EMAIL || undefined,
      authPassword: process.env.BVN_QUERY_AUTH_PASSWORD || undefined,
      useMock:
        process.env.BVN_QUERY_USE_MOCK === 'true' ||
        !process.env.BVN_QUERY_AUTH_EMAIL ||
        !process.env.BVN_QUERY_AUTH_PASSWORD,
    },
    aws: {
      region: process.env.AWS_REGION ?? '',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || undefined,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || undefined,
      s3: {
        bucket: process.env.AWS_S3_BUCKET ?? '',
        signedUrlExpiresInSeconds: parseInt(process.env.AWS_S3_SIGNED_URL_EXPIRES_IN ?? '900', 10),
        useMock:
          process.env.AWS_S3_USE_MOCK === 'true' ||
          !process.env.AWS_ACCESS_KEY_ID ||
          !process.env.AWS_SECRET_ACCESS_KEY,
      },
      rekognition: {
        faceMatchThreshold: parseInt(process.env.AWS_REKOGNITION_FACE_MATCH_THRESHOLD ?? '90', 10),
        // Mirrors AWS_S3_USE_MOCK — same AWS credentials pair backs both S3 and
        // Rekognition, so mock selection falls back on the same presence check.
        // MOCK_FACE_VERIFICATION is a friendlier alias for the same switch
        // (dev/QA convenience — "turn off real face verification for
        // disbursement" reads clearer than the AWS-specific name): either
        // one set to 'true' routes to MockRekognitionAdapter, which always
        // reports a PASSED match (see its own doc comment for the one
        // deterministic-failure escape hatch tests use).
        useMock:
          process.env.AWS_REKOGNITION_USE_MOCK === 'true' ||
          process.env.MOCK_FACE_VERIFICATION === 'true' ||
          !process.env.AWS_ACCESS_KEY_ID ||
          !process.env.AWS_SECRET_ACCESS_KEY,
      },
    },
    brevo: {
      apiKey: process.env.BREVO_API_KEY || undefined,
      senderEmail: process.env.BREVO_SENDER_EMAIL ?? '',
      senderName: process.env.BREVO_SENDER_NAME ?? '',
      mailFrom: process.env.MAIL_FROM || undefined,
      smtp: {
        host: process.env.BREVO_SMTP_HOST ?? 'smtp-relay.brevo.com',
        port: parseInt(process.env.BREVO_SMTP_PORT ?? '465', 10),
        secure: process.env.BREVO_SMTP_SECURE !== 'false',
        login: process.env.BREVO_SMTP_LOGIN || undefined,
        key: process.env.BREVO_SMTP_KEY || undefined,
      },
      // Mirrors BVN_QUERY_USE_MOCK/AWS_S3_USE_MOCK: explicit override, or
      // fall back to mock whenever the SMTP credentials aren't present.
      useMock:
        process.env.BREVO_USE_MOCK === 'true' ||
        !process.env.BREVO_SMTP_LOGIN ||
        !process.env.BREVO_SMTP_KEY,
    },
    termii: {
      apiKey: process.env.TERMII_API_KEY || undefined,
      senderId: process.env.TERMII_SENDER_ID ?? '',
      baseUrl: process.env.TERMII_BASE_URL ?? '',
      useMock: process.env.TERMII_USE_MOCK === 'true' || !process.env.TERMII_API_KEY,
    },
    notification: {
      maxAttempts: parseInt(process.env.NOTIFICATION_MAX_ATTEMPTS ?? '5', 10),
      backoffBaseDelayMs: parseInt(process.env.NOTIFICATION_BACKOFF_BASE_DELAY_MS ?? '5000', 10),
    },
    seed: {
      superAdminEmail: process.env.SEED_SUPERADMIN_EMAIL || undefined,
      superAdminPassword: process.env.SEED_SUPERADMIN_PASSWORD || undefined,
      superAdminFirstName: process.env.SEED_SUPERADMIN_FIRST_NAME ?? 'Super',
      superAdminLastName: process.env.SEED_SUPERADMIN_LAST_NAME ?? 'Admin',
      superAdminPhoneNumber: process.env.SEED_SUPERADMIN_PHONE_NUMBER ?? '08000000000',
      superAdminUserType: parseSeedSuperAdminUserType(process.env.SEED_SUPERADMIN_USER_TYPE),
    },
    authOtp: {
      ttlSeconds: parseInt(process.env.AUTH_OTP_TTL_SECONDS ?? '600', 10),
      maxAttempts: parseInt(process.env.AUTH_OTP_MAX_ATTEMPTS ?? '5', 10),
      defaultCode: process.env.AUTH_OTP_DEFAULT_CODE || undefined,
    },
    passwordReset: {
      ttlSeconds: parseInt(process.env.PASSWORD_RESET_TTL_SECONDS ?? '600', 10),
      maxAttempts: parseInt(process.env.PASSWORD_RESET_MAX_ATTEMPTS ?? '5', 10),
      defaultCode: process.env.PASSWORD_RESET_DEFAULT_CODE || undefined,
    },
    customers: {
      enforceUniquePhoneNumber: process.env.CUSTOMER_ENFORCE_UNIQUE_PHONE !== 'false',
    },
  };
};
