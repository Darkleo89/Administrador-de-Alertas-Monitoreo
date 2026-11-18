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
      evidencias: EvidenciaService.deAlarma(t.alarma_id),
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

  /** Correo con el formato de la plantilla: { html, inlineImages, adjuntos }. */
  paqueteCorreo: function (ticketId) {
    const d = this.datos(ticketId);
    const inline = {};
    const validas = [];
    d.evidencias.forEach((e) => {
      try { inline['ev' + validas.length] = Archivos.blob(e.archivo_id); validas.push(e); }
      catch (err) { console.warn('Evidencia no disponible: ' + e.archivo_id); }
    });
    d.evidencias = validas;
    return { html: Plantillas.correo(d), inlineImages: inline, adjuntos: [this.pdfBlob(ticketId)], datos: d };
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
      evidencias: nEvid[t.id] || 0,
    })).sort((a, b) => new Date(b.creado_en) - new Date(a.creado_en)).slice(0, 500);
  },
};
