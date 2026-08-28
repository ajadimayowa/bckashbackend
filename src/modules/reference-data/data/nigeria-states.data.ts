/**
 * Static Nigeria states + major-cities reference data. Not database-backed —
 * this genuinely never changes at runtime, so a hardcoded module beats a
 * collection + seeder for something with zero write path. `id` is a stable
 * kebab-case slug of the state name (never the array index), so a client
 * can safely persist it (e.g. on a Customer/Branch address) across deploys.
 *
 * City lists are curated major towns/LGA headquarters per state, not an
 * exhaustive list of Nigeria's 774 LGAs — enough to populate an address
 * form's state -> city cascade without shipping a multi-thousand-row dataset.
 */
export interface NigeriaStateSeed {
  id: string;
  name: string;
  cities: readonly string[];
}

export const NIGERIA_STATES_DATA: readonly NigeriaStateSeed[] = [
  { id: 'abia', name: 'Abia', cities: ['Aba', 'Umuahia', 'Ohafia', 'Arochukwu', 'Isiala Ngwa'] },
  { id: 'adamawa', name: 'Adamawa', cities: ['Yola', 'Mubi', 'Numan', 'Ganye', 'Jimeta'] },
  { id: 'akwa-ibom', name: 'Akwa Ibom', cities: ['Uyo', 'Eket', 'Ikot Ekpene', 'Oron', 'Abak'] },
  { id: 'anambra', name: 'Anambra', cities: ['Awka', 'Onitsha', 'Nnewi', 'Ekwulobia', 'Aguata'] },
  { id: 'bauchi', name: 'Bauchi', cities: ['Bauchi', 'Azare', 'Misau', "Jama'are", 'Ningi'] },
  { id: 'bayelsa', name: 'Bayelsa', cities: ['Yenagoa', 'Brass', 'Sagbama', 'Ogbia', 'Nembe'] },
  { id: 'benue', name: 'Benue', cities: ['Makurdi', 'Gboko', 'Otukpo', 'Katsina-Ala', 'Vandeikya'] },
  { id: 'borno', name: 'Borno', cities: ['Maiduguri', 'Biu', 'Bama', 'Dikwa', 'Konduga'] },
  { id: 'cross-river', name: 'Cross River', cities: ['Calabar', 'Ikom', 'Ogoja', 'Obudu', 'Ugep'] },
  { id: 'delta', name: 'Delta', cities: ['Asaba', 'Warri', 'Sapele', 'Ughelli', 'Agbor'] },
  { id: 'ebonyi', name: 'Ebonyi', cities: ['Abakaliki', 'Afikpo', 'Onueke', 'Ezza', 'Ishieke'] },
  { id: 'edo', name: 'Edo', cities: ['Benin City', 'Auchi', 'Ekpoma', 'Uromi', 'Igarra'] },
  { id: 'ekiti', name: 'Ekiti', cities: ['Ado-Ekiti', 'Ikere-Ekiti', 'Ilawe-Ekiti', 'Oye-Ekiti', 'Ise-Ekiti'] },
  { id: 'enugu', name: 'Enugu', cities: ['Enugu', 'Nsukka', 'Oji River', 'Awgu', 'Agbani'] },
  { id: 'gombe', name: 'Gombe', cities: ['Gombe', 'Kaltungo', 'Billiri', 'Dukku', 'Kumo'] },
  { id: 'imo', name: 'Imo', cities: ['Owerri', 'Orlu', 'Okigwe', 'Mbaise', 'Oguta'] },
  { id: 'jigawa', name: 'Jigawa', cities: ['Dutse', 'Hadejia', 'Gumel', 'Birnin Kudu', 'Kazaure'] },
  { id: 'kaduna', name: 'Kaduna', cities: ['Kaduna', 'Zaria', 'Kafanchan', 'Kagoro', 'Sabon Gari'] },
  { id: 'kano', name: 'Kano', cities: ['Kano', 'Wudil', 'Gwarzo', 'Rano', 'Bichi'] },
  { id: 'katsina', name: 'Katsina', cities: ['Katsina', 'Funtua', 'Daura', 'Malumfashi', 'Kankia'] },
  { id: 'kebbi', name: 'Kebbi', cities: ['Birnin Kebbi', 'Argungu', 'Yauri', 'Zuru', 'Jega'] },
  { id: 'kogi', name: 'Kogi', cities: ['Lokoja', 'Okene', 'Idah', 'Kabba', 'Ankpa'] },
  { id: 'kwara', name: 'Kwara', cities: ['Ilorin', 'Offa', 'Omu-Aran', 'Jebba', 'Lafiagi'] },
  { id: 'lagos', name: 'Lagos', cities: ['Ikeja', 'Lagos Island', 'Lekki', 'Surulere', 'Ikorodu', 'Badagry', 'Epe'] },
  { id: 'nasarawa', name: 'Nasarawa', cities: ['Lafia', 'Keffi', 'Akwanga', 'Nasarawa', 'Doma'] },
  { id: 'niger', name: 'Niger', cities: ['Minna', 'Bida', 'Suleja', 'Kontagora', 'Kagara'] },
  { id: 'ogun', name: 'Ogun', cities: ['Abeokuta', 'Ijebu-Ode', 'Sagamu', 'Ota', 'Ilaro'] },
  { id: 'ondo', name: 'Ondo', cities: ['Akure', 'Ondo City', 'Owo', 'Ikare', 'Okitipupa'] },
  { id: 'osun', name: 'Osun', cities: ['Osogbo', 'Ile-Ife', 'Ilesa', 'Ede', 'Ikirun'] },
  { id: 'oyo', name: 'Oyo', cities: ['Ibadan', 'Ogbomoso', 'Iseyin', 'Oyo Town', 'Saki'] },
  { id: 'plateau', name: 'Plateau', cities: ['Jos', 'Bukuru', 'Pankshin', 'Shendam', 'Barkin Ladi'] },
  { id: 'rivers', name: 'Rivers', cities: ['Port Harcourt', 'Bonny', 'Opobo', 'Ahoada', 'Bori'] },
  { id: 'sokoto', name: 'Sokoto', cities: ['Sokoto', 'Tambuwal', 'Wurno', 'Illela', 'Gwadabawa'] },
  { id: 'taraba', name: 'Taraba', cities: ['Jalingo', 'Wukari', 'Bali', 'Gembu', 'Zing'] },
  { id: 'yobe', name: 'Yobe', cities: ['Damaturu', 'Potiskum', 'Nguru', 'Gashua', 'Geidam'] },
  { id: 'zamfara', name: 'Zamfara', cities: ['Gusau', 'Kaura Namoda', 'Talata Mafara', 'Anka', 'Bungudu'] },
  { id: 'fct', name: 'FCT (Abuja)', cities: ['Abuja', 'Gwagwalada', 'Kuje', 'Bwari', 'Kubwa'] },
] as const;
