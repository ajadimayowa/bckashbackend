import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { CityDto } from './dto/city.dto';
import { StateDto } from './dto/state.dto';
import { ReferenceDataService } from './reference-data.service';

/**
 * Static Nigeria states/cities lookup — any authenticated staff member can
 * read it (no capability gate, same "any staff can view" reasoning as
 * OrganisationController's GET), since it's address-form reference data,
 * not something scoped to a role or branch.
 */
@ApiTags('reference-data')
@ApiBearerAuth('access-token')
@Controller('reference-data')
@UseGuards(JwtAuthGuard)
export class ReferenceDataController {
  constructor(private readonly referenceDataService: ReferenceDataService) {}

  @Get('states')
  @ApiOperation({ summary: "List Nigeria's states" })
  listStates(): StateDto[] {
    return this.referenceDataService.listStates();
  }

  @Get('states/:stateId/cities')
  @ApiOperation({
    summary: "List a state's cities",
    description:
      'Each city carries its own id/name plus the parent stateId/stateName, so the ' +
      'response is self-describing without a second round-trip to GET /reference-data/states.',
  })
  listCitiesByState(@Param('stateId') stateId: string): CityDto[] {
    return this.referenceDataService.listCitiesByState(stateId);
  }
}
