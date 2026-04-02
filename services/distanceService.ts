import zipcodes from "zipcodes";

/** Showroom / origin for drive-time estimates (matches default Places discovery bias). */
export const HATFIELD_ORIGIN = { lat: 40.2793, lon: -75.2994 };

const HATFIELD = HATFIELD_ORIGIN;

const haversineMinutes = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const r = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const miles = r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const minutes = miles * 1.6;
  return Math.round(minutes);
};

export const estimateDistanceMinutes = (zip: string, state: string) => {
  const zipInfo = zipcodes.lookup(zip);
  if (zipInfo && typeof zipInfo.latitude === "number" && typeof zipInfo.longitude === "number") {
    return haversineMinutes(HATFIELD.lat, HATFIELD.lon, zipInfo.latitude, zipInfo.longitude);
  }
  if (state === "PA") return 35;
  if (state === "NJ" || state === "DE") return 50;
  return 90;
};

/** Drive-time minutes from lead coordinates to Hatfield origin. */
export const estimateDistanceMinutesFromLatLng = (lat: number, lon: number) =>
  haversineMinutes(HATFIELD.lat, HATFIELD.lon, lat, lon);
