const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const text = (value, max = 300) => typeof value === 'string' ? value.trim().slice(0, max) : '';

async function nycRestaurants(query) {
  const fields = 'camis,dba,boro,building,street,zipcode,latitude,longitude';
  const prefix = query.match(/[\p{L}\p{N}]+/u)?.[0].toUpperCase();
  if (!prefix) return [];
  const params = new URLSearchParams({ '$q': query, '$where': `starts_with(upper(dba), '${prefix}')`, '$select': fields, '$group': fields, '$limit': '20' });
  const response = await fetch('https://data.cityofnewyork.us/resource/43nn-pn8j.json?' + params, { signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error('NYC directory unavailable');
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('Invalid NYC results');
  return [...new Map(rows.map((row) => [row.camis, row])).values()].flatMap((row) => {
    const latitude = Number(row.latitude), longitude = Number(row.longitude);
    if (!text(row.dba) || !row.latitude || !row.longitude || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < 40 || latitude > 42 || longitude < -75 || longitude > -72) return [];
    return [{ name: text(row.dba), address: [[text(row.building), text(row.street)].filter(Boolean).join(' '), text(row.boro), 'NY ' + text(row.zipcode)].filter(Boolean).join(', '), area: text(row.boro) + ', NY', latitude, longitude }];
  });
}

export async function searchPlaces(url, ctx) {
  const query = url.searchParams.get('q')?.trim() || '';
  if (query.length < 2 || query.length > 200) return json({ error: 'Enter a business name or address, between 2 and 200 characters.' }, 400);
  const params = new URLSearchParams({ q: query, limit: '20', lang: 'en' });
  if (url.searchParams.has('lat') || url.searchParams.has('lon')) {
    const lat = url.searchParams.get('lat'), lon = url.searchParams.get('lon');
    if (!lat?.trim() || !lon?.trim() || !Number.isFinite(+lat) || Math.abs(+lat) > 90 || !Number.isFinite(+lon) || Math.abs(+lon) > 180) return json({ error: 'Invalid search location.' }, 400);
    params.set('lat', String(+lat)); params.set('lon', String(+lon));
    params.set('zoom', String(Math.min(18, Math.max(1, Number(url.searchParams.get('zoom')) || 12))));
  }
  const cache = globalThis.caches?.default, key = new Request(`${url.origin}/api/eating/search/v2?${params}`);
  try {
    const cached = await cache?.match(key).catch(() => null);
    if (cached) return json(await cached.json());
    // shortcut: Photon's public service is best-effort; use a dedicated geocoder if search volume grows.
    const photon = async () => {
      const response = await fetch(`https://photon.komoot.io/api/?${params}`, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': `Batcave (${url.origin})` } });
      if (!response.ok) throw new Error('Search unavailable');
      const data = await response.json();
      if (!Array.isArray(data.features)) throw new Error('Invalid search results');
      return data.features.slice(0, 20).flatMap((feature) => {
        const p = feature.properties || {}, coords = feature.geometry?.coordinates;
        if (feature.geometry?.type !== 'Point' || !Array.isArray(coords) || !Number.isFinite(coords[0]) || Math.abs(coords[0]) > 180 || !Number.isFinite(coords[1]) || Math.abs(coords[1]) > 90 || !text(p.name)) return [];
        const street = [text(p.housenumber), text(p.street)].filter(Boolean).join(' ');
        const address = [...new Set([street, text(p.district), text(p.city), text(p.state), text(p.postcode), text(p.country)].filter(Boolean))].join(', ').slice(0, 500);
        return [{ name: text(p.name), address, area: [...new Set([text(p.city) || text(p.district), text(p.state)].filter(Boolean))].join(', ').slice(0, 120), latitude: coords[1], longitude: coords[0] }];
      });
    };
    const nearby = !params.has('lat') || (+params.get('lat') >= 40.4 && +params.get('lat') <= 41 && +params.get('lon') >= -74.3 && +params.get('lon') <= -73.6);
    const sources = await Promise.allSettled([photon(), ...(nearby || /\b(bronx|brooklyn|queens|manhattan|staten island|new york|nyc)\b/i.test(query) ? [nycRestaurants(query)] : [])]);
    if (sources.every((source) => source.status === 'rejected')) throw new Error('Search unavailable');
    const unique = new Map();
    for (const source of [...sources].reverse()) if (source.status === 'fulfilled') for (const place of source.value) {
      const key = [place.name.toLowerCase(), place.latitude.toFixed(3), place.longitude.toFixed(3)].join('|');
      if (!unique.has(key)) unique.set(key, place);
    }
    const partial = sources.some((source) => source.status === 'rejected');
    const result = { places: [...unique.values()].slice(0, 20), ...(partial ? { partial: true } : {}) };
    if (cache && ctx && !partial) ctx.waitUntil(cache.put(key, new Response(JSON.stringify(result), { headers: { 'cache-control': 'public, max-age=3600' } })).catch(() => {}));
    return json(result);
  } catch {
    return json({ error: 'Place search is unavailable. Try again, or add the place manually.' }, 502);
  }
}
