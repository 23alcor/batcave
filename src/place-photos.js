const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const safeUrl = (value) => { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null; } catch { return null; } };

export async function placePhoto(place, env, streetImage = false) {
  if (!env.GOOGLE_MAPS_API_KEY) return json({ error: 'Business photos are not configured.' }, 503);
  const located = Number.isFinite(place.latitude) && Number.isFinite(place.longitude);
  const location = place.address || (located ? `${place.latitude},${place.longitude}` : null);
  if (!location && !place.area) return json({ url: null });
  const street = new URL('https://maps.googleapis.com/maps/api/streetview');
  street.search = new URLSearchParams({ key: env.GOOGLE_MAPS_API_KEY, location: location || '', size: '640x360', return_error_code: 'true', source: 'outdoor' });
  const options = { signal: AbortSignal.timeout(8000) };
  try {
    if (streetImage) {
      if (!location) return json({ error: 'No street address available.' }, 404);
      const response = await fetch(street, options);
      const type = response.headers.get('content-type') || '';
      if (!response.ok || !/^image\/(jpeg|png|webp)\b/.test(type)) return json({ error: 'Street View unavailable.' }, 404);
      return new Response(response.body, { headers: { 'content-type': type, 'cache-control': 'no-store' } });
    }
    try {
      const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
        ...options, method: 'POST', headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY, 'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.photos' },
        body: JSON.stringify({ textQuery: [place.name, place.address || place.area].filter(Boolean).join(', '), pageSize: 1,
          ...(located ? { locationBias: { circle: { center: { latitude: place.latitude, longitude: place.longitude }, radius: 200 } } } : {}) }),
      });
      if (response.ok) {
        const business = (await response.json()).places?.[0];
        const normalize = (name) => (name || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        const expected = normalize(place.name), actual = normalize(business?.displayName?.text);
        const nearby = !located || (business?.location && Math.abs(business.location.latitude - place.latitude) < .003 && Math.abs(business.location.longitude - place.longitude) < .003);
        const photo = expected && actual && (actual.includes(expected) || expected.includes(actual)) && nearby ? business?.photos?.[0] : null;
        if (photo && /^places\/[^/]+\/photos\/[^/]+$/.test(photo.name)) {
          // Google photo references expire and must not be stored or cached.
          const media = await fetch(`https://places.googleapis.com/v1/${photo.name}/media?maxWidthPx=640&skipHttpRedirect=true&key=${encodeURIComponent(env.GOOGLE_MAPS_API_KEY)}`, { signal: AbortSignal.timeout(8000), headers: { 'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY } });
          if (media.ok) {
            const url = safeUrl((await media.json()).photoUri);
            if (url) return json({ url, source: 'Google Maps', maps_url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.name)}&query_place_id=${encodeURIComponent(business.id)}`,
              authors: (photo.authorAttributions || []).map((a) => ({ name: String(a.displayName || ''), url: safeUrl(a.uri) })) });
          }
        }
      }
    } catch { /* A missing Places photo can still have Street View coverage. */ }
    if (!location) return json({ url: null });
    const metadata = new URL(street); metadata.pathname += '/metadata';
    const response = await fetch(metadata, { signal: AbortSignal.timeout(8000) });
    if (!response.ok || (await response.json()).status !== 'OK') return json({ url: null });
    return json({ url: `/api/eating/${encodeURIComponent(place.id)}/photo?street=1`, source: 'Google Street View', authors: [] });
  } catch { return json({ error: 'Business photo unavailable.' }, 502); }
}
