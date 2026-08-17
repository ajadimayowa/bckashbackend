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
    redis: {
      host: process.env.REDIS_HOST ?? 'localhost',
      port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      tls: process.env.REDIS_TLS === 'true',
    },
    jwt: {
      accessSecret: process.env.JWT_ACCESS_SECRET ?? '',
      accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
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
        useMock:
          process.env.AWS_REKOGNITION_USE_MOCK === 'true' ||
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
  };
};
