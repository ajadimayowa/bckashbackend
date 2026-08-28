import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuthService } from './auth.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyLoginOtpDto } from './dto/verify-login-otp.dto';
import { CurrentUser } from './decorators/current-user.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import {
  AuthTokens,
  LoginChallengeResponse,
  LoginResult,
} from './interfaces/jwt-payload.interface';
import { PasswordResetService } from './password-reset.service';
import { StaffService } from './staff.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly staffService: StaffService,
    private readonly passwordResetService: PasswordResetService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Log in (step 1 of 2)',
    description:
      'Validates email/password and, if valid, issues an OTP challenge — sent to the ' +
      "staff member's registered email and phone number. Does NOT return tokens; call " +
      'POST /auth/login/verify-otp with the returned challengeId and the code to ' +
      'actually get an access/refresh token pair. Only ACTIVE staff can log in.',
  })
  login(@Body() dto: LoginDto): Promise<LoginChallengeResponse> {
    return this.authService.login(dto.email, dto.password);
  }

  @Post('login/verify-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Log in (step 2 of 2) — verify the OTP',
    description:
      'Exchanges a still-valid login OTP challenge + code for an access/refresh token ' +
      'pair, plus a userDetails block (firstName/lastName/userType/userLevel/' +
      'mustChangePassword) the frontend can use to route the staff member to their ' +
      'designated protected area, and force a POST /auth/change-password prompt when ' +
      'mustChangePassword is true, without a second round-trip. Single-use; a fixed ' +
      'number of wrong attempts ' +
      '(AUTH_OTP_MAX_ATTEMPTS) or an expired challenge (AUTH_OTP_TTL_SECONDS) both ' +
      'require logging in again from step 1.',
  })
  verifyLoginOtp(@Body() dto: VerifyLoginOtpDto): Promise<LoginResult> {
    return this.authService.verifyLoginOtp(dto.challengeId, dto.code);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh an access token',
    description: 'Exchange a still-valid refresh token for a new access/refresh token pair.',
  })
  refresh(@Body() dto: RefreshTokenDto): Promise<AuthTokens> {
    return this.authService.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Log out',
    description:
      'Revokes the given refresh token so it can no longer be exchanged for a new access token.',
  })
  async logout(@Body() dto: RefreshTokenDto): Promise<void> {
    await this.authService.logout(dto.refreshToken);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Change your own password',
    description:
      'Self-service only. Requires the current password. Every new staff member starts ' +
      'with a system-generated temporary password (see the welcome email) and ' +
      'Staff.mustChangePassword — this is how they set their own. Revokes every ' +
      'outstanding refresh token on success, forcing re-login everywhere else, and sends ' +
      'a confirmation email so a change the staff member did not make gets noticed.',
  })
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() user: { staffId: string },
  ): Promise<void> {
    await this.staffService.changePassword(user.staffId, dto.currentPassword, dto.newPassword);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request a password reset code (no login required)',
    description:
      'Step 1 of 2 for a staff member who is locked out and cannot log in to use ' +
      "POST /auth/change-password. If the email belongs to an ACTIVE staff account, a " +
      "6-digit code is emailed to it (valid for PASSWORD_RESET_TTL_SECONDS, default 10 " +
      'minutes). Always returns the same generic response whether or not the email is ' +
      'registered — do NOT use this response to check whether an email exists. Follow ' +
      'with POST /auth/reset-password using the same email, the code, and a newPassword.',
  })
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<{ message: string }> {
    await this.passwordResetService.requestReset(dto.email);
    return {
      message:
        'If that email is registered and active, a password reset code has been sent to it.',
    };
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Reset your password with an emailed code (step 2 of 2)',
    description:
      'Exchanges a still-valid password reset code (from POST /auth/forgot-password) for ' +
      "a new password — no login/current password required. Single-use; a fixed number " +
      'of wrong attempts (PASSWORD_RESET_MAX_ATTEMPTS) or an expired code ' +
      '(PASSWORD_RESET_TTL_SECONDS) both require requesting a new code from step 1. On ' +
      'success, revokes every outstanding refresh token (forcing re-login everywhere) and ' +
      'sends a confirmation email so an unrecognized reset gets noticed.',
  })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.passwordResetService.resetPassword(dto.email, dto.code, dto.newPassword);
  }
}
