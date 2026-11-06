import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/worker.js';
import { temperature, weatherInfo, weatherIcon } from '../public/weather.js';

const request = (query = '') => new Request('https://test.invalid/api/weather' + query);
const env = { DEV_BYPASS: '1', TIMEZONE: 'America/New_York' };
const fixture = {
  current: { temperature_2m: 0, weather_code: 0, is_day: 0 },
  daily: { time: ['2026-11-05', '2026-11-06'], weather_code: [0, 71], temperature_2m_max: [5, null], temperature_2m_min: [-4, null] },
};

test('weather requires login and rejects missing, nonnumeric, and out-of-range coordinates', async (t) => {
  const upstream = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not call provider'); });
  assert.equal((await worker.fetch(request('?latitude=0&longitude=0'), {})).status, 401);
  for (const query of ['', '?latitude=&longitude=0', '?latitude=1', '?latitude=91&longitude=0', '?latitude=0&longitude=-181', '?latitude=NaN&longitude=0']) {
    assert.equal((await worker.fetch(request(query), env)).status, 400, query);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test('weather preserves zeros and missing data, caches per device location, and keeps responses private', async (t) => {
  const stored = new Map(), pending = [];
  const original = globalThis.caches;
  globalThis.caches = { default: {
    async match(key) { return stored.get(key.url)?.clone(); },
    async put(key, response) { assert.match(response.headers.get('cache-control'), /max-age=900/); stored.set(key.url, response.clone()); },
  } };
  t.after(() => { if (original === undefined) delete globalThis.caches; else globalThis.caches = original; });
  const upstream = t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api.open-meteo.com');
    assert.equal(url.searchParams.get('temperature_unit'), 'fahrenheit');
    assert.equal(url.searchParams.get('timezone'), 'America/New_York');
    assert.equal(url.searchParams.get('forecast_days'), '16');
    assert.equal(url.searchParams.get('past_days'), '7');
    return Response.json(fixture);
  });
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const response = await worker.fetch(request('?latitude=0&longitude=0'), env, ctx);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.equal(data.unit, '°F');
  assert.deepEqual(data.current, { temperature: 0, code: 0, is_day: false });
  assert.deepEqual(data.days['2026-11-05'], { code: 0, high: 5, low: -4 });
  assert.deepEqual(data.days['2026-11-06'], { code: 71, high: null, low: null });
  await Promise.all(pending);
  assert.deepEqual(await (await worker.fetch(request('?latitude=0&longitude=0'), env, ctx)).json(), data);
  assert.equal(upstream.mock.callCount(), 1);
  await worker.fetch(request('?latitude=40.7&longitude=-74'), env, ctx);
  assert.equal(upstream.mock.callCount(), 2, 'A device in a new location must not get the old location forecast');
  await Promise.all(pending);
});

test('weather provider failures and malformed responses return a recoverable error', async (t) => {
  for (const response of [new Response('', { status: 503 }), Response.json({}), Response.json({ daily: { time: ['invalid'] } }), new Response('not json')]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => response.clone());
    const result = await worker.fetch(request('?latitude=40.7&longitude=-74'), env);
    assert.equal(result.status, 502);
    assert.deepEqual(await result.json(), { error: 'Weather unavailable' });
    mock.mock.restore();
  }
});

test('weather labels distinguish conditions, nights, freezing weather and unavailable temperatures', () => {
  assert.equal(temperature(0, '°F'), '0°F');
  assert.equal(temperature(null), '—');
  assert.equal(temperature(-4.2), '-4°');
  assert.equal(weatherInfo(0).label, 'Clear');
  assert.equal(weatherInfo(0, false).icon, 'moon');
  assert.equal(weatherInfo(66).label, 'Freezing rain');
  assert.equal(weatherInfo(71).icon, 'snow');
  assert.equal(weatherInfo(95).icon, 'storm');
  assert.equal(weatherInfo(null).icon, 'unknown');
  assert.ok(weatherIcon('rain').includes('aria-hidden="true"'));
});
