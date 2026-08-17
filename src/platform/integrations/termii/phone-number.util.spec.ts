import { normalizePhoneNumberForTermii } from './phone-number.util';

describe('normalizePhoneNumberForTermii', () => {
  it('converts a leading-0 local number to 234 form', () => {
    expect(normalizePhoneNumberForTermii('08012345678')).toBe('2348012345678');
  });

  it('strips a leading + from an already-international number', () => {
    expect(normalizePhoneNumberForTermii('+2348012345678')).toBe('2348012345678');
  });

  it('leaves an already-normalized 234 number unchanged', () => {
    expect(normalizePhoneNumberForTermii('2348012345678')).toBe('2348012345678');
  });

  it('strips non-digit formatting characters (spaces, dashes)', () => {
    expect(normalizePhoneNumberForTermii('0801-234-5678')).toBe('2348012345678');
  });

  it('prepends 234 to a number missing both the leading 0 and country code', () => {
    expect(normalizePhoneNumberForTermii('8012345678')).toBe('2348012345678');
  });
});
