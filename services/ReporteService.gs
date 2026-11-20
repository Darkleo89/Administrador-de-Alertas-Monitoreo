/**
 * Reporte de incidencia: datos para las plantillas, PDF descargable y paquete del correo.
 */
const ReporteService = {
  /** Reúne todo lo que necesitan Plantillas.correo / Plantillas.reporte. */
  datos: function (ticketId) {
    const t = DB.table('tickets').find(ticketId);
    if (!t) throw new Error('Ticket no encontrado.');
    const alarma = DB.table('alarmas').find(t.alarma_id) || {};
    const estacion = t.estacion_id ? DB.table('estaciones').find(t.estacion_id) : null;
    const u = AuthService.buscarPorUsuario(t.monitorista);
    return {
      ticket: t, alarma: alarma, estacion: estacion,
      monitorista: { login: t.monitorista, nombre: (u && u.nombre) || t.monitorista },
      // Imágenes (captura y fotos) van en el cuerpo; PDF y videos son anexos (adjuntos o enlace).
      evidencias: EvidenciaService.deAlarma(t.alarma_id).filter((e) => e.tipo === 'samsara' || e.tipo === 'foto'),
      anexos: EvidenciaService.deAlarma(t.alarma_id).filter((e) => e.tipo === 'pdf' || e.tipo === 'video'),
      seguimientos: DB.table('seguimientos').where((s) => s.ticket_id === t.id).sort((a, b) => new Date(a.creado_en) - new Date(b.creado_en)),
    };
  },

  nombreArchivo: function (t) {
    return 'Reporte_' + t.folio + '_' + String(t.unidad_id || '').replace(/[^\w\-]+/g, '');
  },

  /** Carga las imágenes (data URI) sin romper el reporte si alguna ya no existe en Drive. */
  conImagenes_: function (d) {
    d.evidencias = d.evidencias.map((e) => {
      try { const b = Archivos.base64(e.archivo_id); return Object.assign({}, e, { src: 'data:' + b.mime + ';base64,' + b.data }); }
      catch (err) { console.warn('Evidencia no disponible: ' + e.archivo_id); return null; }
    }).filter(Boolean);
    return d;
  },

  pdfBlob: function (ticketId) {
    const d = this.conImagenes_(this.datos(ticketId));
    return Archivos.htmlAPdf(Plantillas.reporte(d), this.nombreArchivo(d.ticket));
  },

  /** Para el botón "Descargar PDF": { nombre, base64 }. */
  pdfParaDescarga: function (ticketId, usuario) {
    const t = DB.table('tickets').find(ticketId);
    if (!t) throw new Error('Ticket no encontrado.');
    if (!puedeVerEstacion_(usuario, t.estacion_id)) throw new Error('El ticket pertenece a otra estación.');
    const blob = this.pdfBlob(ticketId);
    return { nombre: blob.getName(), base64: Archivos.pdfBase64(blob) };
  },

  /**
   * Correo con el formato de la plantilla: { html, inlineImages, adjuntos }.
   * PDF y videos van adjuntos (de menor a mayor) mientras el correo no pase de CONFIG.EVIDENCIAS.CORREO_MAX_MB;
   * los que no caben se comparten y van como enlace.
   */
  paqueteCorreo: function (ticketId) {
    const d = this.datos(ticketId);
    const inline = {};
    const validas = [];
    let usado = 0;
    d.evidencias.forEach((e) => {
      try { const b = Archivos.blob(e.archivo_id); inline['ev' + validas.length] = b; validas.push(e); usado += b.getBytes().length; }
      catch (err) { console.warn('Evidencia no disponible: ' + e.archivo_id); }
    });
    d.evidencias = validas;
    const pdf = this.pdfBlob(ticketId);
    usado += pdf.getBytes().length;
    const limite = CONFIG.EVIDENCIAS.CORREO_MAX_MB * 1048576;
    const adjuntos = [pdf];
    d.anexos = d.anexos.slice().sort((a, b) => (Number(a.tamano) || 0) - (Number(b.tamano) || 0)).map((a) => {
      const tam = Number(a.tamano) || 0;
      if (usado + tam <= limite) {
        try { adjuntos.push(Archivos.blob(a.archivo_id).setName(a.nombre)); usado += tam; return Object.assign({}, a, { modo: 'adjunto' }); }
        catch (err) { console.warn('Anexo no disponible: ' + a.archivo_id); }
      }
      try {
        const url = a.enlace || Archivos.compartir(a.archivo_id);
        if (!a.enlace) DB.table('evidencias').update(a.id, { enlace: url });
        return Object.assign({}, a, { modo: 'enlace', enlace: url });
      } catch (err) { return Object.assign({}, a, { modo: 'no_disponible' }); }
    });
    return { html: Plantillas.correo(d), inlineImages: inline, adjuntos: adjuntos, datos: d };
  },

  /** Lista de tickets para la pestaña Reportes. */
  listar: function (usuario, desdeIso, hastaIso, estacionId, texto) {
    const d = new Date(desdeIso).getTime();
    const h = new Date(hastaIso).getTime();
    const q = String(texto || '').trim().toLowerCase();
    const nombres = {};
    DB.table('usuarios').all().forEach((u) => { nombres[u.usuario] = u.nombre; });
    const nEvid = {};
    DB.table('evidencias').all().forEach((e) => { if (e.ticket_id) nEvid[e.ticket_id] = (nEvid[e.ticket_id] || 0) + 1; });
    return DB.table('tickets').where((t) => {
      const f = new Date(t.creado_en).getTime();
      if (f < d || f > h) return false;
      if (!puedeVer_(usuario, t)) return false;
      if (estacionId && esSupervision_(usuario) && String(t.estacion_id) !== String(estacionId)) return false;
      if (q && [t.folio, t.unidad_id, t.operador, t.categoria, t.tipo_evento, t.monitorista, t.cliente, t.ruta].join(' ').toLowerCase().indexOf(q) === -1) return false;
      return true;
    }).map((t) => ({
      id: t.id, folio: t.folio, creado_en: t.creado_en, unidad_id: t.unidad_id, operador: t.operador, categoria: t.categoria,
      tipo_evento: t.tipo_evento, monitorista: nombres[t.monitorista] || t.monitorista, estacion_id: t.estacion_id,
      estatus: t.estatus, escalado_en: t.escalado_en, cliente: t.cliente, bandeja: bandejaDe_(t),
      evidencias: nEvid[t.id] || 0, direccion: t.direccion || '', lugar: t.lugar || '',
    })).sort((a, b) => new Date(b.creado_en) - new Date(a.creado_en)).slice(0, 500);
  },

  // ---------- Descarga en Excel (el navegador arma el .xlsx con estas columnas) ----------
  MAX_DIAS_EXPORTAR: 93,
  ESTATUS_TEXTO: { abierto: 'Abierto', en_seguimiento: 'En seguimiento', escalado: 'Escalado', cerrado: 'Cerrado' },
  /**
   * Columnas del reporte descargable, en orden: [clave, título, tipo, ancho]. Tipos: texto | numero | fecha (dd/MM/yyyy) | enlace.
   * Es la única definición: al migrar, el servidor puede generar el mismo Excel con ella (exceljs, openpyxl).
   */
  COLUMNAS_EXPORTAR: [
    ['folio', 'IDRegistro', 'texto', 24], ['fecha', 'Fecha', 'fecha', 11], ['semana', 'Semana', 'numero', 8],
    ['monitorista', 'Monitorista', 'texto', 30], ['unidad', 'Unidad', 'texto', 10], ['remolque', 'Remolque', 'texto', 26],
    ['conductor', 'Conductor', 'texto', 30], ['ruta', 'Ruta', 'texto', 22], ['operacion', 'Operación', 'texto', 18],
    ['supervisor', 'Supervisor', 'texto', 24], ['incidencia', 'Incidencia', 'texto', 24], ['lugar', 'Lugar de incidencia', 'texto', 36],
    ['coordenadas', 'Coordenadas', 'texto', 24], ['direccion', 'Dirección (según coordenadas)', 'texto', 50], ['mapa', 'Mapa', 'enlace', 11],
    ['hora', 'Hora de incidencia', 'texto', 10], ['descripcion', 'Descripción de incidencia', 'texto', 70], ['circuito', 'Circuito', 'texto', 18],
    ['estacion', 'Estación', 'texto', 22], ['estatus', 'Estatus', 'texto', 14], ['clasificacion', 'Incidencia/Ocurrencia', 'texto', 14],
    ['zona', 'Zona de riesgo', 'texto', 12],
  ],

  /** Tickets de Monitoreo del periodo (por fecha de creación), con lo que el usuario puede ver. */
  exportar: function (usuario, desdeIso, hastaIso, estacionId) {
    const d = new Date(desdeIso).getTime(), h = new Date(hastaIso).getTime();
    if (isNaN(d) || isNaN(h) || h < d) throw new Error('Elige un periodo válido.');
    if (h - d > this.MAX_DIAS_EXPORTAR * 864e5) throw new Error('El periodo máximo por descarga es de ' + this.MAX_DIAS_EXPORTAR + ' días.');
    const nombres = {};
    DB.table('usuarios').all().forEach((u) => { nombres[u.usuario] = u.nombre; });
    const estaciones = {};
    DB.table('estaciones').all().forEach((e) => { estaciones[e.id] = e.nombre; });
    const circuitos = {};
    DB.table('circuitos').all().forEach((c) => { circuitos[c.id] = c.nombre; });
    const tickets = DB.table('tickets').where((t) => {
      const f = new Date(t.creado_en).getTime();
      if (f < d || f > h || bandejaDe_(t) === 'seguridad_vial') return false;
      if (!puedeVer_(usuario, t)) return false;
      return !(estacionId && esSupervision_(usuario) && String(t.estacion_id) !== String(estacionId));
    }).sort((a, b) => new Date(a.fecha_ocurrencia || a.creado_en) - new Date(b.fecha_ocurrencia || b.creado_en));
    const filas = tickets.map((t) => {
      const cuando = new Date(t.fecha_ocurrencia || t.creado_en);
      const coords = this.tieneCoordenadas_(t);
      const desc = String(t.descripcion || '').trim();
      const acc = String(t.acciones || '').trim();
      const v = {
        folio: t.folio, fecha: Plantillas.fecha(cuando), semana: Number(t.semana) || semanaIso_(cuando),
        monitorista: nombres[t.monitorista] || t.monitorista || '', unidad: t.unidad_id || '',
        remolque: [t.remolque1, t.dolly, t.remolque2].map((x) => String(x || '').trim()).filter(Boolean).join(' • ') || 'N/A',
        conductor: t.operador || '', ruta: t.ruta || '', operacion: t.operacion || t.cliente || '', supervisor: t.supervisor || '',
        incidencia: t.categoria || t.tipo_evento || '', lugar: t.lugar || '',
        coordenadas: coords ? '(' + Number(t.lat) + ', ' + Number(t.lng) + ')' : '',
        direccion: t.direccion || (coords ? 'Pendiente' : ''),
        mapa: coords ? 'https://www.google.com/maps?q=' + Number(t.lat) + ',' + Number(t.lng) : '',
        hora: Plantillas.hora(cuando),
        descripcion: desc && acc ? desc + (/[.;,]$/.test(desc) ? ' ' : '. ') + acc : desc || acc,
        circuito: t.circuito || circuitos[t.circuito_id] || '', estacion: estaciones[t.estacion_id] || '',
        estatus: this.ESTATUS_TEXTO[t.estatus] || t.estatus || '', clasificacion: t.clasificacion || '', zona: t.zona_riesgo || '',
      };
      return this.COLUMNAS_EXPORTAR.map((c) => (v[c[0]] === undefined || v[c[0]] === null ? '' : v[c[0]]));
    });
    return {
      columnas: this.COLUMNAS_EXPORTAR.map((c) => ({ clave: c[0], titulo: c[1], tipo: c[2], ancho: c[3] })),
      filas: filas, total: filas.length, desde: desdeIso, hasta: hastaIso, generado_en: new Date(),
    };
  },

  tieneCoordenadas_: function (t) {
    const lat = Number(t.lat), lng = Number(t.lng);
    return t.lat !== '' && t.lat !== null && t.lat !== undefined && !isNaN(lat) && !isNaN(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0);
  },

  // ---------- Dirección por coordenadas: Samsara -> Google -> OpenStreetMap (job de cada minuto) ----------
  DIRECCIONES_POR_CICLO: 10,
  MAX_INTENTOS_DIRECCION: 8,
  /**
   * Completa la dirección de los tickets que tienen coordenadas y aún no la tienen (los más recientes primero).
   * Si ninguna fuente responde, reintenta más tarde (cada vez espera más) y tras varios intentos lo deja como 'sin_direccion'.
   * Llama a la integración Geocoder (Google y OpenStreetMap). Devuelve cuántas completó.
   */
  completarDirecciones: function (max) {
    const repo = DB.table('tickets');
    const ahora = Date.now();
    const pendientes = repo.where((t) => !String(t.direccion || '').trim() && t.direccion_fuente !== 'sin_direccion' && this.tieneCoordenadas_(t) &&
      (!t.direccion_en || ahora - new Date(t.direccion_en).getTime() >= (Number(t.direccion_intentos) || 0) * 30 * 60000))
      .sort((a, b) => new Date(b.creado_en) - new Date(a.creado_en)).slice(0, max || this.DIRECCIONES_POR_CICLO);
    if (!pendientes.length) return 0;
    const cambios = {};
    let n = 0;
    pendientes.forEach((t) => {
      const a = t.alarma_id ? DB.table('alarmas').find(t.alarma_id) : null;
      const deSamsara = a && String(a.origen || '').indexOf('samsara') === 0 ? String(a.direccion || '').trim() : '';
      if (deSamsara) { cambios[t.id] = { direccion: deSamsara, direccion_fuente: 'samsara', direccion_en: new Date() }; n++; return; }
      try {
        const r = Geocoder.direccion(Number(t.lat), Number(t.lng));
        cambios[t.id] = { direccion: r.direccion, direccion_fuente: r.fuente, direccion_en: new Date() };
        n++;
      } catch (e) {
        const intentos = (Number(t.direccion_intentos) || 0) + 1;
        cambios[t.id] = { direccion_intentos: intentos, direccion_en: new Date(), direccion_fuente: intentos >= this.MAX_INTENTOS_DIRECCION ? 'sin_direccion' : '' };
        console.warn('Dirección de ' + t.folio + ': ' + e.message);
      }
    });
    repo.updateMany(cambios);
    return n;
  },
};
