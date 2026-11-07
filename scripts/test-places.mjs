import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/worker.js';
import { placePhoto } from '../src/place-photos.js';

const env = { DEV_BYPASS: '1' };
const request = (path, method = 'GET', body) => new Request('https://test.invalid/api/eating' + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

test('place search requires login and validates query and location before calling the provider', async (t) => {
  const upstream = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not fetch'); });
  assert.equal((await worker.fetch(request('/search?q=Pizza'), {})).status, 401);
  for (const query of ['', '?q=a', '?q=' + 'x'.repeat(201), '?q=Pizza&lat=91&lon=0', '?q=Pizza&lat=0', '?q=Pizza&lat=0&lon=no']) {
    assert.equal((await worker.fetch(request('/search' + query), env)).status, 400);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test('place search normalizes businesses, safely passes query text, and caches results by location', async (t) => {
  const original = globalThis.caches, stored = new Map(), pending = [];
  globalThis.caches = { default: {
    async match(key) { return stored.get(key.url)?.clone(); },
    async put(key, response) { stored.set(key.url, response.clone()); },
  } };
  t.after(() => { if (original === undefined) delete globalThis.caches; else globalThis.caches = original; });
  const upstream = t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.hostname === 'data.cityofnewyork.us') return Response.json([]);
    assert.equal(url.origin, 'https://photon.komoot.io');
    assert.equal(url.searchParams.get('q'), 'Pizza & pasta');
    assert.equal(url.searchParams.get('limit'), '20');
    return Response.json({ features: [
      { properties: { name: 'Pizza <test>', housenumber: '12', street: 'Main St', city: 'New York', state: 'New York', country: 'USA' }, geometry: { type: 'Point', coordinates: [-74.01, 40.71] } },
      { properties: { name: 'Bad coordinates' }, geometry: { type: 'Point', coordinates: [0, 100] } },
      { properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } },
    ] });
  });
  const path = '/search?q=Pizza%20%26%20pasta&lat=40.71&lon=-74.01';
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const result = await worker.fetch(request(path), env, ctx);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const data = await result.json();
  assert.deepEqual(data.places, [{ name: 'Pizza <test>', address: '12 Main St, New York, USA', area: 'New York', latitude: 40.71, longitude: -74.01 }]);
  await Promise.all(pending);
  assert.deepEqual(await (await worker.fetch(request(path), env, ctx)).json(), data);
  assert.equal(upstream.mock.callCount(), 2);
  await worker.fetch(request(path.replace('40.71', '41.71')), env, ctx);
  assert.equal(upstream.mock.callCount(), 3);
  await Promise.all(pending);
});

test('place search fails gracefully when the provider is unavailable', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  const response = await worker.fetch(request('/search?q=Pizza'), env);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /add the place manually/);
});

test('place search keeps business matches beyond the first six', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input) => new URL(input).hostname === 'data.cityofnewyork.us' ? Response.json([]) : Response.json({ features: Array.from({ length: 12 }, (_, i) => ({
    properties: { name: `Business branch ${i + 1}`, city: 'New York' }, geometry: { type: 'Point', coordinates: [-74 + i / 1000, 40.71] },
  })) }));
  const response = await worker.fetch(request('/search?q=Business'), env);
  const data = await response.json();
  assert.equal(data.places.length, 12);
  assert.equal(data.places[11].name, 'Business branch 12');
});

test('selected locations persist in the same shared list; manual places still work and invalid coordinates are rejected', async () => {
  const stored = [];
  const local = { ...env, DB: { prepare(sql) {
    let args;
    return {
      bind(...values) { args = values; return this; },
      async first() { assert.match(sql, /SELECT space FROM eat_members/); return 'shared-list'; },
      async run() {
        assert.match(sql, /^INSERT INTO places/);
        assert.equal(args[5], 'shared-list');
        stored.push(Object.fromEntries(['id', 'name', 'cuisine', 'area', 'status', 'space', 'address', 'latitude', 'longitude'].map((key, i) => [key, args[i]])));
        return { meta: { changes: 1 } };
      },
      async all() {
        if (sql.startsWith('SELECT * FROM places')) { assert.deepEqual(args, ['shared-list']); return { results: stored }; }
        if (sql.startsWith('SELECT uid FROM eat_members')) return { results: [{ uid: 0 }] };
        assert.match(sql, /FROM place_dishes/); return { results: [] };
      },
    };
  } } };
  for (const body of [{ name: 'Bad', latitude: 91, longitude: 0 }, { name: 'Bad', latitude: 0 }, { name: 'Bad', latitude: '1', longitude: '2' }]) {
    assert.equal((await worker.fetch(request('', 'POST', body), local)).status, 400);
  }
  assert.equal(stored.length, 0);
  assert.equal((await worker.fetch(request('', 'POST', { name: 'Cafe', address: '1 Main St', latitude: 0, longitude: 0 }), local)).status, 201);
  assert.equal((await worker.fetch(request('', 'POST', { name: 'Manual place', area: 'Downtown' }), local)).status, 201);
  const data = await (await worker.fetch(request(''), local)).json();
  assert.equal(data.places[0].address, '1 Main St');
  assert.equal(data.places[0].latitude, 0);
  assert.equal(data.places[0].longitude, 0);
  assert.equal(data.places[1].latitude, null);
  assert.equal(data.places[1].address, null);
});

test('NYC restaurant search finds Kyan when Photon misses it and tolerates a failed source', async (t) => {
  let failPhoton = false;
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.hostname === 'photon.komoot.io') return failPhoton ? new Response('', { status: 503 }) : Response.json({ features: [] });
    assert.equal(url.searchParams.get('$where'), "starts_with(upper(dba), 'KYAN')");
    assert.equal(url.searchParams.get('$q'), 'Kyan Morris park Bronx');
    return Response.json([
      { camis: '50160199', dba: 'KYAN', boro: 'Bronx', building: '689', street: 'MORRIS PARK AVENUE', zipcode: '10462', latitude: '40.845186064829', longitude: '-73.866297521118' },
      { camis: 'missing', dba: 'KYAN', latitude: '0', longitude: '0' },
    ]);
  });
  for (const partial of [false, true]) {
    failPhoton = partial;
    const data = await (await worker.fetch(request('/search?q=Kyan%20Morris%20park%20Bronx'), env)).json();
    assert.equal(data.places.length, 1);
    assert.equal(data.places[0].address, '689 MORRIS PARK AVENUE, Bronx, NY 10462');
    assert.equal(!!data.partial, partial);
  }
});

test('Eating Out edits validate dates and scope all mutations to the current shared list', async () => {
  const writes = [];
  const local = { ...env, DB: { prepare(sql) {
    let args;
    return { bind(...values) { args = values; return this; },
      async first() { return 'shared-list'; },
      async run() { writes.push({ sql, args }); return { meta: { changes: args.includes('missing') ? 0 : 1 } }; },
    };
  } } };
  assert.equal((await worker.fetch(request('/place', 'PATCH', { name: 'New name', address: 'New address' }), local)).status, 200);
  assert.match(writes.at(-1).sql, /AND space =/);
  assert.deepEqual(writes.at(-1).args, ['New name', 'New address', 'place', 'shared-list']);
  for (const day of ['2026-02-30', '2026-13-01', 'not a date', null]) {
    assert.equal((await worker.fetch(request('/dishes/dish', 'PATCH', { day }), local)).status, 400);
  }
  assert.equal(writes.length, 1);
  assert.equal((await worker.fetch(request('/dishes/dish', 'PATCH', { day: '2026-11-02', notes: '' }), local)).status, 200);
  assert.match(writes.at(-1).sql, /place_id IN \(SELECT id FROM places WHERE space =/);
  for (const path of ['/place', '/dishes/dish', '/missing', '/dishes/missing']) {
    const response = await worker.fetch(request(path, 'DELETE'), local);
    assert.equal(response.status, path.includes('missing') ? 404 : 200);
    assert.equal(writes.at(-1).args.at(-1), 'shared-list');
  }
});

const photoPlace = { id: 'cafe', name: 'Kyan', address: '689 Morris Park Avenue, Bronx', latitude: 40.84518, longitude: -73.8663 };
const photoEnv = { GOOGLE_MAPS_API_KEY: 'mock-maps-key' };

test('business photos require configuration and a place in the current shared list', async (t) => {
  const upstream = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not call Google'); });
  assert.equal((await placePhoto(photoPlace, {})).status, 503);
  const local = { ...env, ...photoEnv, DB: { prepare(sql) { return { bind() { return this; }, async first() { return sql.includes('eat_members') ? 'my-list' : null; } }; } } };
  assert.equal((await worker.fetch(request('/foreign/photo'), local)).status, 404);
  assert.equal(upstream.mock.callCount(), 0);
});

test('business photos use the first matched Google photo with author credits and no caching', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input); calls++;
    if (url.pathname.endsWith(':searchText')) {
      assert.equal(options.headers['X-Goog-Api-Key'], 'mock-maps-key');
      assert.match(JSON.parse(options.body).textQuery, /Kyan, 689 Morris Park/);
      return Response.json({ places: [{ id: 'google-id', displayName: { text: 'KYAN' }, location: { latitude: 40.84518, longitude: -73.8663 }, photos: [
        { name: 'places/google-id/photos/first', authorAttributions: [{ displayName: 'Photographer', uri: 'https://maps.google.com/contrib/123' }] },
        { name: 'places/google-id/photos/second' },
      ] }] });
    }
    assert.equal(url.pathname, '/v1/places/google-id/photos/first/media');
    assert.equal(url.searchParams.get('skipHttpRedirect'), 'true');
    return Response.json({ photoUri: 'https://lh3.googleusercontent.com/business-photo' });
  });
  const response = await placePhoto(photoPlace, photoEnv), data = await response.json();
  assert.equal(calls, 2); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(data.url, 'https://lh3.googleusercontent.com/business-photo');
  assert.equal(data.authors[0].name, 'Photographer');
  assert.ok(!JSON.stringify(data).includes('mock-maps-key'));
});

test('wrong Google business matches fall back to Street View; unavailable imagery stays empty', async (t) => {
  let available = true;
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = new URL(input);
    if (url.hostname === 'places.googleapis.com') return Response.json({ places: [{ displayName: { text: 'Unrelated business' }, photos: [{ name: 'places/wrong/photos/first' }] }] });
    assert.equal(url.pathname, '/maps/api/streetview/metadata');
    assert.equal(url.searchParams.get('location'), photoPlace.address);
    return Response.json({ status: available ? 'OK' : 'ZERO_RESULTS' });
  });
  const response = await placePhoto(photoPlace, photoEnv), data = await response.json();
  assert.equal(data.url, '/api/eating/cafe/photo?street=1');
  assert.equal(data.source, 'Google Street View');
  available = false;
  assert.equal((await (await placePhoto(photoPlace, photoEnv)).json()).url, null);
});

test('Street View proxies image content without leaking the key or an upstream error image', async (t) => {
  let failed = false;
  t.mock.method(globalThis, 'fetch', async (input) => {
    assert.equal(new URL(input).searchParams.get('return_error_code'), 'true');
    return failed ? new Response('Error with private key', { status: 403 }) : new Response('image bytes', { headers: { 'content-type': 'image/jpeg' } });
  });
  const response = await placePhoto(photoPlace, photoEnv, true);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  failed = true;
  const error = await placePhoto(photoPlace, photoEnv, true);
  assert.equal(error.status, 404); assert.ok(!(await error.text()).includes('private key'));
});
