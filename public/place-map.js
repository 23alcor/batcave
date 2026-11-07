let library;
function leaflet() {
  if (!library) library = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    css.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY='; css.crossOrigin = '';
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.integrity = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo='; script.crossOrigin = '';
    script.onload = () => resolve(window.L);
    script.onerror = () => { library = null; css.remove(); script.remove(); reject(new Error('Map unavailable. You can still search and add a place.')); };
    document.head.append(css, script);
  });
  return library;
}

export function setupPlaceMap(root, api, esc) {
  const view = root.parentElement, form = view.querySelector('[data-form="add-place"]');
  const search = root.querySelector('form'), results = root.querySelector('[data-map-results]'), status = root.querySelector('[data-map-status]');
  const picked = view.querySelector('[data-map-picked]');
  let active = true, map, L, resultLayer, found = [], selected = null, center = null;
  const opener = view.querySelector('[data-map-open]');
  let loading;
  const say = (message) => { if (active) status.textContent = message; };
  const label = (place) => { const el = document.createElement('span'); el.textContent = place.name; return el; };
  function choose(place, index) {
    selected = index;
    Object.assign(form.dataset, { latitude: String(place.latitude), longitude: String(place.longitude), address: place.address || '' });
    form.elements.name.value = place.name; form.elements.area.value = place.area || '';
    picked.textContent = place.address || `${place.latitude.toFixed(5)}, ${place.longitude.toFixed(5)}`;
    results.querySelectorAll('[data-map-result]').forEach((button) => { button.setAttribute('aria-pressed', String(+button.dataset.mapResult === index)); });
    map?.setView([place.latitude, place.longitude], 17);
    root.close();
    opener.textContent = 'Change address';
    form.elements.name.focus({ preventScroll: true });
    say(`${place.name} selected. Choose a status, then Add.`);
  }
  function drawResults() {
    if (!map) return;
    resultLayer.clearLayers();
    found.forEach((place, index) => L.circleMarker([place.latitude, place.longitude], { radius: 9, weight: 2, fillOpacity: .9, color: '#ffffff', fillColor: getComputedStyle(root).getPropertyValue('--accent').trim() })
      .bindTooltip(label(place)).on('click', () => choose(place, index)).addTo(resultLayer));
    if (selected != null && found[selected]) map.setView([found[selected].latitude, found[selected].longitude], 17);
    else if (found.length) map.fitBounds(found.map((p) => [p.latitude, p.longitude]), { padding: [28, 28], maxZoom: 16 });
  }
  const loadMap = () => loading ||= leaflet().then((loaded) => {
    if (!active || !root.isConnected) return;
    L = loaded;
    map = L.map(root.querySelector('[data-place-map]'), { scrollWheelZoom: false, zoomAnimation: false, fadeAnimation: false }).setView(center || [20, 0], center ? 13 : 2);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors' }).addTo(map);
    resultLayer = L.layerGroup().addTo(map);
    drawResults(); say('Search a business name. Add a city to narrow the results, or use Near me.');
  }).catch((error) => { loading = null; say(error.message); });
  opener.onclick = () => {
    root.showModal();
    if (!search.elements.query.value) search.elements.query.value = form.elements.name.value;
    if (map) map.invalidateSize(); else loadMap();
    search.elements.query.focus();
  };
  root.querySelector('[data-map-close]').onclick = () => root.close();

  search.onsubmit = async (event) => {
    event.preventDefault();
    const query = search.elements.query.value.trim();
    if (query.length < 2) return;
    const button = search.querySelector('[type="submit"]');
    button.disabled = true; say('Searching…');
    try {
      const params = new URLSearchParams({ q: query });
      if (map && map.getZoom() >= 6) { const c = map.getCenter(); params.set('lat', c.lat.toFixed(2)); params.set('lon', c.lng.toFixed(2)); params.set('zoom', String(map.getZoom())); }
      else if (center) { params.set('lat', center[0].toFixed(2)); params.set('lon', center[1].toFixed(2)); }
      const response = await api('/api/eating/search?' + params);
      if (!active) return;
      if (form.dataset.latitude !== undefined) { form.elements.name.value = ''; form.elements.area.value = ''; clearSelection(); }
      found = response.places; selected = null;
      results.innerHTML = found.map((p, i) => `<button type="button" class="place-result" data-map-result="${i}" aria-pressed="false"><strong>${esc(p.name)}</strong><span>${esc(p.address || p.area || 'Address unavailable')}</span></button>`).join('');
      drawResults(); say((found.length ? `${found.length} results. Choose the right business below or on the map.` : 'No places found. Try adding a city, or enter the place manually below.') + (response.partial ? ' A search source is unavailable; try again for more results.' : ''));
    } catch (error) { say(error.message); }
    finally { button.disabled = false; }
  };
  results.onclick = (event) => { const button = event.target.closest('[data-map-result]'); if (button) choose(found[+button.dataset.mapResult], +button.dataset.mapResult); };
  root.querySelector('[data-map-nearby]').onclick = () => {
    if (!navigator.geolocation) return say('Location is unavailable. Add a city to your search.');
    say('Finding your location…');
    navigator.geolocation.getCurrentPosition((position) => {
      if (!active) return;
      center = [position.coords.latitude, position.coords.longitude];
      map?.setView(center, 13); say('Map centered near you. Search for a business name.');
    }, () => say('Location unavailable. Add a city to your search.'), { maximumAge: 300000, timeout: 10000 });
  };
  const clearSelection = () => {
    delete form.dataset.latitude; delete form.dataset.longitude; delete form.dataset.address;
    picked.textContent = ''; selected = null; opener.textContent = 'Add address';
    results.querySelectorAll('[aria-pressed]').forEach((button) => button.setAttribute('aria-pressed', 'false'));
  };
  form.elements.name.addEventListener('input', clearSelection);
  return () => { active = false; root.close(); map?.remove(); form.elements.name.removeEventListener('input', clearSelection); };
}

export function setupPlacePhotos(view, api, esc) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) {
      const figure = entry.target;
      observer.unobserve(figure);
      api(`/api/eating/${encodeURIComponent(figure.dataset.placePhoto)}/photo`).then((photo) => {
        if (!figure.isConnected) return;
        if (!photo.url) { figure.querySelector('span').textContent = 'Photo unavailable'; return; }
        figure.innerHTML = `<img src="${esc(photo.url)}" alt="${esc(figure.getAttribute('aria-label'))}" loading="lazy"><figcaption>${photo.maps_url ? `<a href="${esc(photo.maps_url)}" target="_blank" rel="noopener noreferrer">${esc(photo.source)}</a>` : esc(photo.source)}${photo.authors.map((a) => a.url ? ` · <a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.name)}</a>` : ` · ${esc(a.name)}`).join('')}</figcaption>`;
        figure.querySelector('img').onerror = () => { figure.innerHTML = '<span class="place-photo-empty">Photo unavailable</span>'; };
      }).catch(() => { if (figure.isConnected) figure.innerHTML = '<span class="place-photo-empty">Photo unavailable</span>'; });
    }
  });
  view.querySelectorAll('[data-place-photo]').forEach((el) => observer.observe(el));
  return () => observer.disconnect();
}
