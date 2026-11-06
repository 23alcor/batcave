import { cfg } from './config.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

// One forecast serves the date widget and every calendar day for 15 minutes.
export async function weather(url, ctx) {
  const lat = url.searchParams.get('latitude'), lon = url.searchParams.get('longitude');
  const latitude = Number(lat), longitude = Number(lon);
  if (!lat?.trim() || !lon?.trim()
    || !Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
    return json({ error: 'Valid latitude and longitude are required' }, 400);
  }
  const params = new URLSearchParams({ latitude, longitude, timezone: cfg.tz, temperature_unit: 'fahrenheit',
    current: 'temperature_2m,weather_code,is_day', daily: 'weather_code,temperature_2m_max,temperature_2m_min', past_days: '7', forecast_days: '16' });
  const key = new Request(`${url.origin}/api/weather/cache?${params}`);
  const cache = globalThis.caches?.default;
  try {
    const cached = await cache?.match(key).catch(() => null);
    if (cached) return json(await cached.json());
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error('Weather provider unavailable');
    const data = await response.json();
    if (!Array.isArray(data.daily?.time) || !data.daily.time.length) throw new Error('Weather data unavailable');
    const number = (value) => Number.isFinite(value) ? value : null;
    const days = {};
    data.daily.time.forEach((day, i) => {
      if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)) days[day] = {
        code: number(data.daily.weather_code?.[i]), high: number(data.daily.temperature_2m_max?.[i]), low: number(data.daily.temperature_2m_min?.[i]),
      };
    });
    if (!Object.keys(days).length) throw new Error('Weather dates unavailable');
    const result = { location: 'Current location', unit: '°F', updated_at: new Date().toISOString(),
      current: Number.isFinite(data.current?.temperature_2m) ? { temperature: data.current.temperature_2m, code: number(data.current.weather_code), is_day: data.current.is_day !== 0 } : null,
      days };
    if (cache && ctx) ctx.waitUntil(cache.put(key, new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=900' } })).catch(() => {}));
    return json(result);
  } catch {
    return json({ error: 'Weather unavailable' }, 502);
  }
}
