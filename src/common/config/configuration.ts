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
  };
}

export interface BrevoConfig {
  apiKey?: string;
  senderEmail: string;
  senderName: string;
}

export interface TermiiConfig {
  apiKey?: string;
  senderId: string;
  baseUrl: string;
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
      },
    },
    brevo: {
      apiKey: process.env.BREVO_API_KEY || undefined,
      senderEmail: process.env.BREVO_SENDER_EMAIL ?? '',
      senderName: process.env.BREVO_SENDER_NAME ?? '',
    },
    termii: {
      apiKey: process.env.TERMII_API_KEY || undefined,
      senderId: process.env.TERMII_SENDER_ID ?? '',
      baseUrl: process.env.TERMII_BASE_URL ?? '',
    },
  };
};
