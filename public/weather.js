export const temperature = (value, unit = '°') => Number.isFinite(value) ? `${Math.round(value)}${unit}` : '—';

export function weatherInfo(code, isDay = true) {
  if (code === 0 || code === 1) return { label: code === 0 ? (isDay ? 'Clear' : 'Clear night') : 'Mostly clear', icon: isDay ? 'sun' : 'moon' };
  if (code === 2) return { label: 'Partly cloudy', icon: 'cloud' };
  if (code === 3) return { label: 'Overcast', icon: 'cloud' };
  if ([45, 48].includes(code)) return { label: 'Fog', icon: 'fog' };
  if ([51, 53, 55, 56, 57].includes(code)) return { label: code >= 56 ? 'Freezing drizzle' : 'Drizzle', icon: 'rain' };
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { label: [66, 67].includes(code) ? 'Freezing rain' : 'Rain', icon: 'rain' };
  if ([71, 73, 75, 77, 85, 86].includes(code)) return { label: 'Snow', icon: 'snow' };
  if ([95, 96, 97, 99].includes(code)) return { label: 'Thunderstorms', icon: 'storm' };
  return { label: 'Conditions unavailable', icon: 'unknown' };
}

export function weatherIcon(icon) {
  const cloud = '<path d="M7 16a5 5 0 1 1 1-9 6 6 0 0 1 11 3 3 3 0 0 1-1 6Z"/>';
  const shapes = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    moon: '<path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z"/>',
    cloud,
    rain: cloud + '<path d="m8 19-1 2m6-2-1 2m6-2-1 2"/>',
    snow: cloud + '<path d="M8 20h.01M13 21h.01M18 20h.01" stroke-width="3"/>',
    storm: cloud + '<path d="m13 17-3 4h4l-2 3"/>',
    fog: cloud + '<path d="M4 19h16M7 22h10"/>',
    unknown: '<path d="M8 12h8"/>',
  };
  return `<svg class="weather-symbol" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[icon] || shapes.unknown}</svg>`;
}
