import { ConfigModule } from '@nestjs/config';
import { DynamicModule } from '@nestjs/common';

/**
 * Minimal global ConfigModule for tests that need `ConfigService.get('jwt')`
 * without going through the full Joi-validated env schema (which requires
 * MONGO_URI, AWS/NIBSS/Brevo/Termii credentials, etc. — irrelevant noise for
 * an identity-module unit test).
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
      }),
    ],
  });
}
