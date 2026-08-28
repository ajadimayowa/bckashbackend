import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import type ms from 'ms';

import type { JwtConfig } from '../../common/config/configuration';
import { BvnIntegrationModule } from '../../platform/integrations/bvn/bvn.module';
import { WorkflowEngineModule } from '../../platform/workflow-engine/workflow-engine.module';
// Cross-module schema registration only — see staff.service.ts's comment and
// PHASE_3_NOTES.md. No import of BranchesModule/BranchesService (or
// Customers/Groups/Loans' equivalents) here.
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import { Customer, CustomerSchema } from '../customers/schemas/customer.schema';
import { Group, GroupSchema } from '../groups/schemas/group.schema';
import { Loan, LoanSchema } from '../loans/schemas/loan.schema';
import { AuthOtpService } from './auth-otp.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DepartmentsController } from './departments.controller';
import { DepartmentsService } from './departments.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RefreshTokenService } from './refresh-token.service';
import { Department, DepartmentSchema } from './schemas/department.schema';
import { LoginOtpChallenge, LoginOtpChallengeSchema } from './schemas/login-otp-challenge.schema';
import {
  PasswordResetChallenge,
  PasswordResetChallengeSchema,
} from './schemas/password-reset-challenge.schema';
import { RefreshToken, RefreshTokenSchema } from './schemas/refresh-token.schema';
import { Staff, StaffSchema } from './schemas/staff.schema';
import { Unit, UnitSchema } from './schemas/unit.schema';
import { PasswordResetService } from './password-reset.service';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { UnitsController } from './units.controller';
import { UnitsService } from './units.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Department.name, schema: DepartmentSchema },
      { name: Unit.name, schema: UnitSchema },
      { name: Staff.name, schema: StaffSchema },
      { name: RefreshToken.name, schema: RefreshTokenSchema },
      { name: Branch.name, schema: BranchSchema },
      { name: Customer.name, schema: CustomerSchema },
      { name: Group.name, schema: GroupSchema },
      { name: Loan.name, schema: LoanSchema },
      { name: LoginOtpChallenge.name, schema: LoginOtpChallengeSchema },
      { name: PasswordResetChallenge.name, schema: PasswordResetChallengeSchema },
    ]),
    WorkflowEngineModule,
    BvnIntegrationModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const jwtConfig = config.get<JwtConfig>('jwt');
        return {
          secret: jwtConfig?.accessSecret,
          // Cast: config value is a validated plain `string` (e.g. "4h"), not
          // @nestjs/jwt's stricter `number | ms.StringValue` signOptions type.
          signOptions: { expiresIn: jwtConfig?.accessExpiresIn as ms.StringValue },
        };
      },
    }),
  ],
  controllers: [DepartmentsController, UnitsController, StaffController, AuthController],
  providers: [
    DepartmentsService,
    UnitsService,
    StaffService,
    AuthService,
    AuthOtpService,
    PasswordResetService,
    RefreshTokenService,
    JwtStrategy,
    JwtAuthGuard,
  ],
  exports: [DepartmentsService, UnitsService, StaffService, JwtAuthGuard],
})
export class IdentityModule {}
