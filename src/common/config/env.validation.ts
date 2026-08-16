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

  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').optional(),
  REDIS_TLS: Joi.boolean().default(false),

  JWT_ACCESS_SECRET: Joi.string().min(16).required(),
  JWT_ACCESS_EXPIRES_IN: Joi.string().default('15m'),
  JWT_REFRESH_SECRET: Joi.string().min(16).required(),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),

  PII_ENCRYPTION_KEY: Joi.string().min(32).required(),

  NIBSS_BASE_URL: Joi.string().uri().required(),
  NIBSS_CLIENT_ID: Joi.string().allow('').optional(),
  NIBSS_CLIENT_SECRET: Joi.string().allow('').optional(),
  NIBSS_API_KEY: Joi.string().allow('').optional(),

  AWS_REGION: Joi.string().required(),
  AWS_ACCESS_KEY_ID: Joi.string().allow('').optional(),
  AWS_SECRET_ACCESS_KEY: Joi.string().allow('').optional(),
  AWS_S3_BUCKET: Joi.string().required(),
  AWS_S3_SIGNED_URL_EXPIRES_IN: Joi.number().positive().default(900),
  AWS_REKOGNITION_FACE_MATCH_THRESHOLD: Joi.number().min(0).max(100).default(90),

  BREVO_API_KEY: Joi.string().allow('').optional(),
  BREVO_SENDER_EMAIL: Joi.string().email().required(),
  BREVO_SENDER_NAME: Joi.string().required(),

  TERMII_API_KEY: Joi.string().allow('').optional(),
  TERMII_SENDER_ID: Joi.string().required(),
  TERMII_BASE_URL: Joi.string().uri().required(),
});
