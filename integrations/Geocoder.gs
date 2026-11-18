/**
 * Dirección a partir de coordenadas (geocodificación inversa).
 * Orden de fuentes (la de Samsara la resuelve ReporteService con la dirección que trae la alarma):
 *   1. Google: servicio Maps de Apps Script (sin clave; tiene límite diario).
 *   2. OpenStreetMap / Nominatim: sin clave, máximo 1 consulta por segundo. Solo recibe las coordenadas.
 * Al migrar a Docker se reimplementa solo este archivo (p. ej. Google Geocoding API con clave + Nominatim).
 */
const Geocoder = {
  NOMINATIM_URL: 'https://nominatim.openstreetmap.org/reverse',
  ultimaOsm_: 0,

  google: function (lat, lng) {
    const r = Maps.newGeocoder().setLanguage('es').reverseGeocode(lat, lng);
    if (!r || r.status !== 'OK' || !r.results || !r.results.length) throw new Error('Google: ' + ((r && r.status) || 'sin respuesta'));
    return r.results[0].formatted_address;
  },

  osm: function (lat, lng) {
    const espera = 1100 - (Date.now() - this.ultimaOsm_);   // política de Nominatim: 1 consulta por segundo
    if (espera > 0) Utilities.sleep(espera);
    this.ultimaOsm_ = Date.now();
    const url = this.NOMINATIM_URL + '?format=jsonv2&zoom=18&accept-language=es&lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lng);
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'User-Agent': 'MonitoreoFlota/1.0', Accept: 'application/json' } });
    if (resp.getResponseCode() !== 200) throw new Error('OpenStreetMap ' + resp.getResponseCode());
    const j = JSON.parse(resp.getContentText());
    if (!j || !j.display_name) throw new Error('OpenStreetMap: sin dirección');
    return j.display_name;
  },

  /** { direccion, fuente: 'google' | 'osm' }. Si ninguna responde, lanza los errores de ambas. */
  direccion: function (lat, lng) {
    const errores = [];
    const fuentes = ['google', 'osm'];
    for (let i = 0; i < fuentes.length; i++) {
      try {
        const d = this[fuentes[i]](lat, lng);
        if (d) return { direccion: String(d), fuente: fuentes[i] };
      } catch (e) { errores.push(e.message); }
    }
    throw new Error(errores.join(' | '));
  },
};
