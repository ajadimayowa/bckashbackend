import { DynamicModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

/**
 * Minimal global ConfigModule for tests that need `ConfigService.get('bvn')`
 * — same reasoning as test-jwt-config.module.ts. `useMock: false` by
 * default so RealBvnVerificationAdapter/BvnProviderAuthService tests
 * actually exercise the real HTTP-calling code paths (with `fetch` mocked).
 */
export function testBvnConfigModule(
  overrides: Partial<{ baseUrl: string; authEmail: string; authPassword: string }> = {},
): Promise<DynamicModule> {
  return ConfigModule.forRoot({
    isGlobal: true,
    ignoreEnvFile: true,
    load: [
      () => ({
        bvn: {
          baseUrl: overrides.baseUrl ?? 'https://bvn-test.example.com/v1',
          authEmail: overrides.authEmail ?? 'test@example.com',
          authPassword: overrides.authPassword ?? 'test-password',
          useMock: false,
        },
      }),
    ],
  });
}
