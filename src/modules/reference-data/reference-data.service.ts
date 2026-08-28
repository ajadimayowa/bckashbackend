import { Injectable, NotFoundException } from '@nestjs/common';
import { NIGERIA_STATES_DATA } from './data/nigeria-states.data';
import { CityDto } from './dto/city.dto';
import { StateDto } from './dto/state.dto';

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

@Injectable()
export class ReferenceDataService {
  listStates(): StateDto[] {
    return NIGERIA_STATES_DATA.map((state) => ({ id: state.id, name: state.name }));
  }

  listCitiesByState(stateId: string): CityDto[] {
    const state = NIGERIA_STATES_DATA.find((candidate) => candidate.id === stateId);
    if (!state) {
      throw new NotFoundException(`Unknown stateId: ${stateId}`);
    }

    // Every city carries its parent state's id/name too — see CityDto's own doc comment.
    return state.cities.map((city) => ({
      id: `${state.id}-${slugify(city)}`,
      name: city,
      stateId: state.id,
      stateName: state.name,
    }));
  }
}
