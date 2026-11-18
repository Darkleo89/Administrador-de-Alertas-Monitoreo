/**
 * Cliente de la API de Samsara (https://developers.samsara.com).
 * El token va en la propiedad del script SAMSARA_API_TOKEN (nunca en el código ni en Git).
 * Permisos requeridos del token: "Read Safety Events & Scores" y "Read Alerts"
 * (y "Read Drivers" para capacitación).
 */
const SamsaraClient = {
  request: function (path, params) {
    const token = getSetting_('SAMSARA_API_TOKEN', true);
    const qs = [];
    Object.keys(params || {}).forEach((k) => {
      const v = params[k];
      if (v === undefined || v === null || v === '') return;
      if (Array.isArray(v)) v.forEach((x) => qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(x)));
      else qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    const url = CONFIG.SAMSARA.BASE_URL + path + (qs.length ? '?' + qs.join('&') : '');
    const opts = { method: 'get', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, muteHttpExceptions: true };
    let resp = UrlFetchApp.fetch(url, opts);
    if (resp.getResponseCode() === 429) { Utilities.sleep(1500); resp = UrlFetchApp.fetch(url, opts); }
    if (resp.getResponseCode() >= 300) {
      throw new Error('Samsara ' + resp.getResponseCode() + ' en ' + path + ': ' + resp.getContentText().slice(0, 300));
    }
    return JSON.parse(resp.getContentText());
  },

  /** GET /safety-events/stream  (startTime obligatorio; `after` = cursor de la página anterior) */
  safetyEventsStream: function (p) {
    return this.request('/safety-events/stream', p);
  },

  /** GET /alerts/incidents/stream  (configurationIds obligatorio, 1–50 ids) */
  alertIncidentsStream: function (p) {
    return this.request('/alerts/incidents/stream', p);
  },

  /** GET /tags (paginado): [{ id, name, parentTagId, vehicles[{id,name}], assets[{id,name}] }] */
  listarTags: function () {
    const tags = [];
    let after = '';
    for (let i = 0; i < 50; i++) {
      const r = this.request('/tags', { limit: 512, after: after });
      (r.data || []).forEach((t) => tags.push(t));
      const p = r.pagination || {};
      if (!p.hasNextPage || !p.endCursor) break;
      after = p.endCursor;
    }
    return tags;
  },

  /** Recorre todas las páginas de un endpoint de lista de Samsara. */
  paginar_: function (path, params) {
    const out = [];
    let after = '';
    for (let i = 0; i < 50; i++) {
      const r = this.request(path, Object.assign({ limit: 512, after: after }, params || {}));
      (r.data || []).forEach((x) => out.push(x));
      const p = r.pagination || {};
      if (!p.hasNextPage || !p.endCursor) break;
      after = p.endCursor;
    }
    return out;
  },

  /** GET /fleet/drivers (activos): [{ id, name, username, driverActivationStatus, tags }] — permiso Read Drivers */
  listarConductoresActivos: function () {
    return this.paginar_('/fleet/drivers', { driverActivationStatus: 'active' });
  },

  /** GET /fleet/trailers: [{ id, name, tags[{id,name,parentTagId}], licensePlate }] — permiso Read Trailers */
  listarRemolques: function () {
    return this.paginar_('/fleet/trailers', {});
  },

  /** GET /alerts/configurations (todas las páginas): [{ id, name, isEnabled, ... }] — permiso Read Alerts */
  listarConfiguracionesAlertas: function () {
    const out = [];
    let after = '';
    let status = 'all';
    for (let i = 0; i < 50; i++) {
      let r;
      try { r = this.request('/alerts/configurations', { status: status, after: after }); }
      catch (e) { if (status && i === 0) { status = ''; i--; continue; } throw e; }   // por si la cuenta no acepta status
      (r.data || []).forEach((x) => out.push(x));
      const p = r.pagination || {};
      if (!p.hasNextPage || !p.endCursor) break;
      after = p.endCursor;
    }
    return out;
  },

  /**
   * Diagnóstico (solo lectura): cómo responde GET /alerts/configurations con cada filtro de status, y
   * opcionalmente una alerta por id (el número de la dirección de la alerta en Samsara) y sus incidentes de 7 días.
   * texto = parte del nombre a buscar (p. ej. "PARADA"). Nunca devuelve el token.
   */
  diagnosticoAlertas: function (texto, id) {
    const K = (s) => CatalogoService.clave(s);
    const busca = K(texto);
    const resumen = (c) => ({ id: String(c.id), nombre: c.name, habilitada: c.isEnabled, disparadores: (c.triggers || []).map((t) => t && (t.type !== undefined ? t.type : t.triggerTypeId)) });
    const out = { consultas: [], por_id: null, incidentes: null, ejemplo: null };
    const ids = {};
    ['all', 'enabled', 'disabled', ''].forEach((status) => {
      const q = { status: status || 'sin filtro', paginas: 0, total: 0, coinciden: [], error: '' };
      try {
        let after = '';
        for (let i = 0; i < 50; i++) {
          const r = this.request('/alerts/configurations', { status: status, after: after });
          q.paginas++;
          (r.data || []).forEach((c) => {
            q.total++; ids[String(c.id)] = c.name;
            if (busca && K(c.name).indexOf(busca) !== -1) {
              q.coinciden.push(resumen(c));
              if (!out.ejemplo) out.ejemplo = JSON.stringify(c).slice(0, 3000);
            }
          });
          const p = r.pagination || {};
          if (!p.hasNextPage || !p.endCursor) break;
          after = p.endCursor;
        }
      } catch (e) { q.error = e.message; }
      out.consultas.push(q);
    });
    out.distintas = Object.keys(ids).length;
    id = String(id || '').trim();
    if (id) {
      try {
        const r = this.request('/alerts/configurations', { ids: [id] });
        out.por_id = { encontradas: (r.data || []).map(resumen), crudo: JSON.stringify(r).slice(0, 3000) };
      } catch (e) { out.por_id = { error: e.message }; }
      try {
        const r = this.request('/alerts/incidents/stream', { configurationIds: [id], startTime: new Date(Date.now() - 7 * 864e5).toISOString() });
        out.incidentes = { total: (r.data || []).length, ejemplo: JSON.stringify((r.data || [])[0] || null).slice(0, 2000) };
      } catch (e) { out.incidentes = { error: e.message }; }
    }
    return out;
  },

  /** Devuelve [{ nombre, modulosPct, safetyScore }] para el tablero de capacitación. */
  obtenerResumenOperadores: function () {
    const drivers = this.request('/fleet/drivers', {}).data || [];
    return drivers.map((d) => ({
      nombre: d.name,
      modulosPct: null,   // TODO: endpoint de capacitaciones
      safetyScore: null,  // TODO: endpoint de safety score
    }));
  },
};
