import { ConfigModule } from '@nestjs/config';
import { DynamicModule } from '@nestjs/common';

/**
 * Minimal global ConfigModule for tests that need `ConfigService.get('jwt')`
 * without going through the full Joi-validated env schema (which requires
 * MONGO_URI, AWS/NIBSS/Brevo/Termii credentials, etc. — irrelevant noise for
 * an identity-module unit test). Also carries `authOtp` — AuthOtpService's
 * config namespace — since AuthService now depends on it too (the two-step
 * login flow). `defaultCode` is deliberately left unset: tests capture the
 * real random code via `LOGIN_OTP_ISSUED_EVENT` rather than relying on the
 * dev-only override, so this also exercises the actual random-generation path.
 */
export function testJwtConfigModule(): Promise<DynamicModule> {
  return ConfigModule.forRoot({
    isGlobal: true,
    ignoreEnvFile: true,
    load: [
      () => ({
        jwt: {
          accessSecret: 'test-access-secret-not-for-production',
          accessExpiresIn: '15m',
          refreshSecret: 'test-refresh-secret-not-for-production',
          refreshExpiresIn: '7d',
        },
        authOtp: {
          ttlSeconds: 600,
          maxAttempts: 5,
        },
      }),
    ],
  });
}
