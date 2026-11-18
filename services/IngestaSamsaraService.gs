/**
 * Ingesta periódica de alarmas desde Samsara (trigger cada CONFIG.SAMSARA.INTERVALO_MIN).
 *  1) Eventos de seguridad (IA/cámaras): GET /safety-events/stream  (cursor persistente)
 *  2) Alertas configuradas (pánico, paradas, desvíos…): GET /alerts/incidents/stream
 *     -> las que el Admin marca "Vigilar" en Configuración → Samsara → Alertas y cámaras (tabla alertas_samsara),
 *        más los ids de la propiedad SAMSARA_ALERT_CONFIG_IDS si existe.
 * Deduplica por `externo_id`, asigna la estación según la unidad (hoja `unidades`) y agrupa las
 * alertas repetidas de la misma unidad mientras la alarma siga abierta (repeticiones).
 */
const IngestaSamsaraService = {
  MAX_PAGINAS: 10,
  MAX_IDS_POR_CONSULTA: 50,   // límite de Samsara en configurationIds
  /** UrlFetchApp rechaza URLs de más de ~2 KB: cada id ocupa ~55 caracteres en la URL. */
  MAX_CARACTERES_IDS: 1500,
  BANDEJAS_: ['monitoreo', 'seguridad_vial'],
  /** Sufijo del externo_id para la copia de Seguridad Vial (la de Monitoreo conserva el id original). */
  sufijo_: function (bandeja) { return bandeja === 'seguridad_vial' ? ':sv' : ''; },

  ejecutar: function (idsExtra) {
    const unidades = DB.table('unidades').all();
    // Estación por etiqueta de Samsara (para remolques u otros activos que no están en el catálogo de unidades)
    const estPorTag = {};
    DB.table('estaciones').where((e) => e.activa !== false && e.samsara_tag_id).forEach((e) => { estPorTag[String(e.samsara_tag_id)] = e.id; });
    const alarmas = DB.table('alarmas').where((a) => String(a.origen || '').indexOf('samsara') === 0);
    const existentes = {};
    alarmas.forEach((a) => { existentes[a.externo_id] = true; });
    // Alarmas de alerta aún abiertas, por alerta + unidad (para agrupar repeticiones)
    const abiertas = {};
    alarmas.forEach((a) => {
      if (a.origen === 'samsara_alerta' && (a.estatus === 'nueva' || a.estatus === 'en_atencion')) {
        abiertas[this.claveGrupo_(a)] = a;
      }
    });

    // Monitoreo: solo vehículos con etiqueta de estación (si ya se sincronizaron estaciones desde Samsara).
    // Seguridad Vial revisa TODA la flota: si algo le llega, los eventos de cámara se leen sin filtro de etiquetas.
    const tagIds = CONFIG.SAMSARA.SOLO_UNIDADES_MONITOREO ? CatalogoSamsaraService.tagIdsActivos() : [];
    const filtrar = tagIds.length > 0;
    const todaLaFlota = AlertasSamsaraService.hayDestino('seguridad_vial');

    const nuevas = [];
    const repetidas = {};
    const agregar = (alarma) => {
      if (!alarma || existentes[alarma.externo_id]) return;
      existentes[alarma.externo_id] = true;
      const a = this.asignarEstacion_(alarma, unidades);
      const tags = a.tags_samsara_ || [];
      delete a.tags_samsara_;
      if (!a.estacion_id) {
        const t = tags.map((x) => estPorTag[String(x.id)]).filter(Boolean)[0];
        if (t) a.estacion_id = t;
      }
      // Alerta con estaciones: la ven esas estaciones aunque la unidad sea de otra (o no tenga etiqueta de Monitoreo)
      const est = estacionesDe_(a);
      if (est.length) a.estacion_id = est.length === 1 ? est[0] : '';
      else if (filtrar && !a.estacion_id && a.bandeja !== 'seguridad_vial') return;   // vehículo fuera de Monitoreo
      if (a.origen === 'samsara_alerta') {
        const k = this.claveGrupo_(a);
        const previa = abiertas[k];
        if (previa) {
          if (!previa.id) {   // la primera también llegó en esta misma consulta
            previa.repeticiones = (Number(previa.repeticiones) || 1) + 1;
            if (new Date(a.recibida_en) > new Date(previa.ultima_en)) previa.ultima_en = a.recibida_en;
            return;
          }
          const r = repetidas[previa.id] || { repeticiones: Number(previa.repeticiones) || 1, ultima_en: previa.ultima_en || previa.recibida_en };
          r.repeticiones++;
          if (new Date(a.recibida_en) > new Date(r.ultima_en)) r.ultima_en = a.recibida_en;
          repetidas[previa.id] = r;
          return;
        }
        abiertas[k] = a;
      }
      nuevas.push(a);
    };

    // Eventos de cámara: solo los que tienen al menos una etiqueta vigilada (las etiquetas nuevas se agregan solas)
    const eventos = this.leerEventosSeguridad_(todaLaFlota ? [] : tagIds);
    const etiquetasVistas = {};
    eventos.forEach((ev) => (ev.behaviorLabels || []).forEach((b) => { if (b && b.label) etiquetasVistas[b.label] = true; }));
    let reglas = AlertasSamsaraService.reglasSeguridad();
    const faltan = Object.keys(etiquetasVistas).filter((l) => !reglas[l]);
    if (faltan.length || !Object.keys(reglas).length) {
      AlertasSamsaraService.asegurarEtiquetas(faltan.concat(AlertasSamsaraService.ETIQUETAS_SEGURIDAD.map((e) => e[0])));
      reglas = AlertasSamsaraService.reglasSeguridad();
    }
    // Un mismo evento puede llegar a las dos áreas (alarmas separadas: cada una lo atiende a su manera)
    eventos.forEach((ev) => this.BANDEJAS_.forEach((b) => agregar(this.mapearEventoSeguridad(ev, reglas, b))));

    // Alertas configuradas: si aún no se conocen, se descubren de Samsara la primera vez
    if (!DB.table('alertas_samsara').all().length) {
      try { AlertasSamsaraService.sincronizar(); } catch (e) { console.error(e); }
    }
    const vigiladas = AlertasSamsaraService.vigiladas();
    const ids = Object.keys(vigiladas);
    (idsExtra || []).forEach((id) => { if (ids.indexOf(String(id)) === -1) ids.push(String(id)); });
    let errorAlertas = null;
    if (ids.length) {
      try {
        this.leerIncidentes_(ids)
          .sort((x, y) => new Date(x.happenedAtTime) - new Date(y.happenedAtTime))
          .forEach((inc) => {
            const cfg = vigiladas[String(inc.configurationId)];
            const bandejas = cfg ? AlertasSamsaraService.bandejasDe(AlertasSamsaraService.destinoDe(cfg)) : ['monitoreo'];
            bandejas.forEach((b) => {
              const al = this.mapearIncidente(inc, cfg, b);
              if (al && b === 'monitoreo' && cfg) al.estaciones = AlertasSamsaraService.estacionesDe(cfg).join(';');
              agregar(al);
            });
          });
      } catch (e) { errorAlertas = e; }   // los eventos de cámara se guardan de todos modos
    }

    DB.table('alarmas').insertMany(nuevas);
    if (Object.keys(repetidas).length) DB.table('alarmas').updateMany(repetidas);
    this.confirmarCursorSeguridad_();
    if (errorAlertas) throw new Error('Alertas configuradas: ' + errorAlertas.message);
    return nuevas.length;
  },

  /** Guarda el cursor de eventos de seguridad solo después de insertar (si algo falla, se vuelven a leer). */
  confirmarCursorSeguridad_: function () {
    const c = this.cursorPendiente_;
    this.cursorPendiente_ = null;
    if (!c) return;
    Object.keys(c).forEach((k) => Parametros.set(k, c[k]));
  },

  /** Divide los ids en lotes que caben en la URL (y en el máximo de Samsara). */
  lotes_: function (ids) {
    const out = [];
    let lote = [], largo = 0;
    ids.forEach((id) => {
      const n = encodeURIComponent(String(id)).length + 18;   // "&configurationIds=" + id
      if (lote.length && (lote.length >= this.MAX_IDS_POR_CONSULTA || largo + n > this.MAX_CARACTERES_IDS)) { out.push(lote); lote = []; largo = 0; }
      lote.push(id); largo += n;
    });
    if (lote.length) out.push(lote);
    return out;
  },

  /** Misma alerta configurada + misma unidad. */
  claveGrupo_: function (a) {
    const cfg = String(a.externo_id || '').split(':')[1] || '';
    return cfg + '|' + bandejaDe_(a) + '|' + (a.samsara_asset_id || CatalogoService.clave(a.unidad_id));
  },

  leerEventosSeguridad_: function (tagIds) {
    const ahora = new Date();
    const filtroTags = (tagIds || []).slice().sort().join(',');
    // El cursor depende de los filtros: si cambian las estaciones, se reinicia la consulta.
    if (Parametros.get('samsara_safety_tags') !== filtroTags) {
      Parametros.set('samsara_safety_tags', filtroTags);
      Parametros.set('samsara_safety_cursor', '');
      Parametros.set('samsara_safety_inicio', Parametros.get('samsara_safety_inicio') ? new Date(ahora.getTime() - 15 * 60000).toISOString() : '');
    }
    let inicio = Parametros.get('samsara_safety_inicio');
    if (!inicio) {
      inicio = new Date(ahora.getTime() - CONFIG.SAMSARA.VENTANA_INICIAL_MIN * 60000).toISOString();
      Parametros.set('samsara_safety_inicio', inicio);
    }
    let cursor = Parametros.get('samsara_safety_cursor') || '';
    const eventos = [];
    for (let i = 0; i < this.MAX_PAGINAS; i++) {
      const resp = SamsaraClient.safetyEventsStream({ startTime: inicio, after: cursor, includeAsset: true, includeDriver: true, tagIds: filtroTags });
      (resp.data || []).forEach((e) => eventos.push(e));
      const pag = resp.pagination || {};
      if (pag.endCursor) cursor = pag.endCursor;
      if (!pag.hasNextPage) break;
    }
    // Se guarda al final de ejecutar(), ya insertadas las alarmas.
    this.cursorPendiente_ = cursor ? { samsara_safety_cursor: cursor }
      // Sin cursor: reiniciar la ventana para no releer todo el historial en cada ciclo.
      : { samsara_safety_inicio: new Date(ahora.getTime() - 5 * 60000).toISOString() };
    return eventos;
  },

  leerIncidentes_: function (configIds) {
    const ahora = new Date();
    const ultimo = Parametros.get('samsara_alertas_ultimo');
    const inicio = ultimo ? new Date(new Date(ultimo).getTime() - 2 * 60000)   // 2 min de traslape
                          : new Date(ahora.getTime() - CONFIG.SAMSARA.VENTANA_INICIAL_MIN * 60000);
    const incidentes = [];
    this.lotes_(configIds).forEach((lote) => {
      let cursor = '';
      for (let i = 0; i < this.MAX_PAGINAS; i++) {
        const resp = SamsaraClient.alertIncidentsStream({
          configurationIds: lote, startTime: inicio.toISOString(), endTime: ahora.toISOString(), after: cursor,
        });
        (resp.data || []).forEach((x) => incidentes.push(x));
        const pag = resp.pagination || {};
        if (!pag.hasNextPage || !pag.endCursor) break;
        cursor = pag.endCursor;
      }
    });
    Parametros.set('samsara_alertas_ultimo', ahora.toISOString());
    return incidentes;
  },

  /**
   * Evento de seguridad de Samsara -> alarma. `reglas` = { etiqueta: fila de alertas_samsara }.
   * `bandeja` = área para la que se arma la alarma (monitoreo | seguridad_vial): solo cuentan las etiquetas
   * que le llegan a esa área. Devuelve null si ninguna le llega. Sin `reglas` (diagnóstico) acepta todo.
   */
  mapearEventoSeguridad: function (ev, reglas, bandeja) {
    bandeja = bandeja || 'monitoreo';
    const etiquetas = (ev.behaviorLabels || []).map((b) => b.label).filter(Boolean);
    let vigiladas = null;
    if (reglas) {
      const llega = (r) => r && AlertasSamsaraService.bandejasDe(AlertasSamsaraService.destinoDe(r)).indexOf(bandeja) !== -1;
      vigiladas = (etiquetas.length ? etiquetas : ['']).map((l) => reglas[l]).filter(llega);
      if (!vigiladas.length && (etiquetas.length || bandeja !== 'monitoreo')) return null;   // sin etiquetas: solo Monitoreo
      vigiladas.sort((x, y) => ordenSeveridad_(x.severidad) - ordenSeveridad_(y.severidad));
    }
    const texto = etiquetas.join(' ');
    const regla = CONFIG.SAMSARA.MAPEO_ETIQUETAS.find((m) => m.re.test(texto));
    const principal = vigiladas && vigiladas[0];
    const tipo = principal && principal.tipo_id ? DB.table('tipos_incidencia').find(principal.tipo_id) : null;
    const asset = ev.asset || {};
    const driver = ev.driver || {};
    const loc = ev.location || {};
    const nombres = vigiladas && vigiladas.length ? vigiladas.map((r) => r.nombre).filter((n, k, arr) => arr.indexOf(n) === k).join(', ') : '';
    return {
      origen: 'samsara_seguridad', externo_id: 'se:' + ev.id + this.sufijo_(bandeja), bandeja: bandeja,
      unidad_id: asset.name || asset.id || '', samsara_asset_id: asset.id || '',
      operador: driver.name || '',
      categoria: tipo ? tipo.nombre : regla ? regla.categoria : 'Conducta del operador',
      tipo_evento: nombres || (regla && regla.tipo) || (etiquetas.length ? etiquetas.join(', ') : 'Evento de seguridad'),
      severidad: principal ? principal.severidad || 'media' : regla ? regla.severidad : CONFIG.SAMSARA.SEVERIDAD_SIN_MAPEO,
      tipo_id: principal ? principal.tipo_id || '' : '',
      alertas_ids: vigiladas ? vigiladas.map((r) => r.configuracion_id).join(';') : '',
      lat: loc.latitude || '', lng: loc.longitude || '',
      direccion: (loc.address && (loc.address.formattedAddress || loc.address.name)) || '',
      url_origen: ev.inboxEventUrl || ev.incidentReportUrl || '',
      recibida_en: new Date(ev.createdAtTime || Date.now()),
      estatus: 'nueva',
    };
  },

  /**
   * Incidente de alerta configurada -> alarma. `config` es la fila de alertas_samsara (nombre, severidad,
   * tipo sugerido). La estructura de `conditions` varía por tipo de alerta, así que el vehículo, el operador
   * y la ubicación se buscan de forma defensiva.
   */
  mapearIncidente: function (inc, config, bandeja) {
    config = config || {};
    bandeja = bandeja || 'monitoreo';
    const vehiculo = buscarProfundo_(inc.conditions, ['vehicle', 'asset', 'trailer']) || {};
    const operador = buscarProfundo_(inc.conditions, ['driver']) || {};
    const ubic = buscarProfundo_(inc.conditions, ['location', 'gps']) || {};
    const condicion = (inc.conditions || []).map((c) => c.description || c.triggerId || '').filter(Boolean).join(' / ');
    const nombre = config.nombre || condicion || 'Alerta Samsara';
    const tipo = config.tipo_id ? DB.table('tipos_incidencia').find(config.tipo_id) : null;
    let categoria = tipo ? tipo.nombre : '';
    let severidad = config.severidad || '';
    if (!categoria || !severidad) {
      const texto = CatalogoService.clave(nombre + ' ' + condicion);
      let cat = 'Alerta Samsara', sev = 'alta';
      if (/PANIC/.test(texto)) { cat = 'Botón de pánico'; sev = 'critica'; }
      else if (/GPS|DESCONEX|DISCONNECT|UNPLUG|SIGNAL|SENAL|BATER/.test(texto)) cat = 'Falla GPS / Desconexión';
      else if (/DESVIO|ROUTE|GEOCERCA|GEOFENCE/.test(texto)) cat = 'Desvío de ruta';
      else if (/PARADA|STOP|IDLE/.test(texto)) { cat = 'Parada no autorizada'; sev = 'media'; }
      else if (/FAULT|FALLA|MOTOR|ENGINE|TEMPERAT/.test(texto)) cat = 'Falla mecánica';
      categoria = categoria || cat;
      severidad = severidad || sev;
    }
    const lat = ubic.latitude !== undefined ? ubic.latitude : ubic.lat;
    const lng = ubic.longitude !== undefined ? ubic.longitude : ubic.lng;
    const geo = ubic.reverseGeo && ubic.reverseGeo.formattedLocation;
    const cuando = new Date(inc.happenedAtTime || Date.now());
    return {
      tags_samsara_: Array.isArray(vehiculo.tags) ? vehiculo.tags : [],   // solo para elegir estación; no se guarda
      origen: 'samsara_alerta',
      externo_id: 'ai:' + inc.configurationId + ':' + inc.happenedAtTime + ':' + (vehiculo.id || '') + this.sufijo_(bandeja), bandeja: bandeja,
      unidad_id: vehiculo.name || vehiculo.id || '', samsara_asset_id: vehiculo.id || '',
      operador: operador.name || '', categoria: categoria,
      tipo_evento: nombre + (condicion && condicion !== nombre ? ' · ' + condicion : ''),
      severidad: severidad, tipo_id: config.tipo_id || '', alertas_ids: String(inc.configurationId || ''),
      lat: lat === undefined || lat === null ? '' : lat, lng: lng === undefined || lng === null ? '' : lng,
      direccion: (ubic.address && (ubic.address.formattedAddress || ubic.address.name)) || ubic.formattedAddress || geo || '',
      url_origen: inc.incidentUrl || '', recibida_en: cuando, estatus: 'nueva',
      repeticiones: 1, ultima_en: cuando,
    };
  },

  asignarEstacion_: function (alarma, unidades) {
    const u = buscarUnidad_(unidades, alarma.samsara_asset_id, alarma.unidad_id);
    if (u) {
      alarma.estacion_id = u.estacion_id || '';
      alarma.unidad_id = u.economico || alarma.unidad_id;
      if (!alarma.operador) alarma.operador = u.operador || '';
    }
    return alarma;
  },
};

/** Busca recursivamente el primer objeto bajo alguna de las claves dadas. */
function buscarProfundo_(obj, claves, prof) {
  prof = prof || 0;
  if (!obj || typeof obj !== 'object' || prof > 6) return null;
  for (let i = 0; i < claves.length; i++) {
    if (obj[claves[i]] && typeof obj[claves[i]] === 'object' && !Array.isArray(obj[claves[i]])) return obj[claves[i]];
  }
  const vals = Array.isArray(obj) ? obj : Object.keys(obj).map((k) => obj[k]);
  for (let j = 0; j < vals.length; j++) {
    const r = buscarProfundo_(vals[j], claves, prof + 1);
    if (r) return r;
  }
  return null;
}
