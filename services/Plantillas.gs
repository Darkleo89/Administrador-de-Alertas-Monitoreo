/**
 * Plantillas HTML del correo del ticket y del reporte PDF.
 * Estructura tomada de las fuentes del cuaderno NotebookLM "Analisis Caso de Negocio":
 *   - "Platilla para Correo.pdf"  -> Plantillas.correo()
 *   - "Plantilla de Reporte.pdf"  -> Plantillas.reporte()
 * Solo tablas y estilos en línea (compatibles con Gmail/Outlook y con el conversor HTML->PDF).
 *
 * `d` es el objeto que arma ReporteService.datos():
 *   { ticket, alarma, estacion, monitorista: {nombre, login}, evidencias: [{tipo, src, nombre}], seguimientos }
 */
const Plantillas = {
  COLOR: '#1f4e79',
  COLOR_SUAVE: '#eaf0f7',

  /**
   * Asunto del correo (formato del negocio):
   *   "A-126 - OCURRENCIA DAÑO A INFRAESTRUCTURA · GAL-TCK-..."  (si el tipo es Ocurrencia)
   *   "G-539 - TRANSITO LENTO · GAL-TCK-..."                    (si es Incidencia)
   * El correo de escalamiento agrega el prefijo [ESCALADO] (NotificationService.enviarEscalamiento).
   */
  asunto: function (t) {
    if (t.bandeja === 'seguridad_vial') {
      return 'SEGURIDAD VIAL - ' + String(t.unidad_id || 'SIN UNIDAD').toUpperCase() + ' - ' + String(t.tipo_evento || '').toUpperCase() + ' · ' + t.folio;
    }
    return String(t.unidad_id || 'SIN UNIDAD').toUpperCase() + ' - ' + (t.clasificacion === 'Ocurrencia' ? 'OCURRENCIA ' : '') +
      String(t.tipo_evento || t.categoria || '').toUpperCase() + ' · ' + t.folio;
  },

  esc: function (v) {
    return String(v === null || v === undefined || v === '' ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
  val: function (v) { return v === null || v === undefined || v === '' ? '—' : this.esc(v); },
  fecha: function (d) { return d ? Utilities.formatDate(new Date(d), CONFIG_TZ_(), 'dd/MM/yyyy') : '—'; },
  hora: function (d) { return d ? Utilities.formatDate(new Date(d), CONFIG_TZ_(), 'HH:mm') : '—'; },
  coords: function (t) { return t.lat && t.lng ? Number(t.lat).toFixed(6) + ', ' + Number(t.lng).toFixed(6) : ''; },
  mapaUrl: function (t) { return t.lat && t.lng ? 'https://maps.google.com/?q=' + t.lat + ',' + t.lng : ''; },
  seccion: function (titulo) {
    return '<tr><td style="padding:18px 0 6px"><div style="border-left:5px solid ' + this.COLOR + ';padding:4px 10px;font-weight:bold;font-size:14px;color:' + this.COLOR + ';background:' + this.COLOR_SUAVE + '">' + this.esc(titulo) + '</div></td></tr>';
  },

  /** Correo del ticket ("Platilla para Correo.pdf"). Las imágenes usan cid:evN (inlineImages). */
  correo: function (d) {
    const t = d.ticket;
    const sv = t.bandeja === 'seguridad_vial';
    const video = sv && t.url_video ? '<br><br><b>Video del evento:</b> <a href="' + this.esc(t.url_video) + '" style="color:' + this.COLOR + '">' + this.esc(t.url_video) + '</a>' : '';
    const th = 'style="background:' + this.COLOR + ';color:#fff;font-size:11px;font-weight:bold;padding:6px 5px;border:1px solid #c9d3df;text-align:center"';
    const td = 'style="font-size:12px;padding:7px 5px;border:1px solid #c9d3df;text-align:center;vertical-align:top;background:#ffffff;color:#1d2330"';
    const mapa = this.mapaUrl(t) ? '<a href="' + this.esc(this.mapaUrl(t)) + '" style="color:' + this.COLOR + '">Ver en Maps</a>' : '—';
    const fila1 = [['FECHA', this.fecha(t.fecha_ocurrencia)], ['SEMANA', this.val(t.semana)], [sv ? 'ANALISTA' : 'MONITORISTA', this.val(d.monitorista.nombre)],
      ['UNIDAD', this.val(t.unidad_id)], ['REMOLQUE', this.val([t.remolque1, t.remolque2].filter(Boolean).join(' / '))],
      ['CONDUCTOR', this.val(t.operador)], ['RUTA', this.val(t.ruta)]];
    const fila2 = [['OPERACIÓN', this.val(t.operacion)], ['SUPERVISOR', this.val(t.supervisor)], [sv ? 'CONDUCTA' : 'INCIDENCIA', this.val(t.tipo_evento || t.categoria)],
      ['LUGAR', this.val(t.lugar)], ['HORA', this.hora(t.fecha_ocurrencia)], ['UBICACIÓN MAPA', mapa], ['COORDENADAS', this.val(this.coords(t))]];
    const grid = (fila) => '<tr>' + fila.map((c) => '<td ' + th + '>' + c[0] + '</td>').join('') + '</tr><tr>' + fila.map((c) => '<td ' + td + '>' + c[1] + '</td>').join('') + '</tr>';
    const fotos = d.evidencias.length
      ? d.evidencias.map((e, i) => '<img src="cid:ev' + i + '" alt="' + this.esc(e.nombre) + '" style="width:31%;max-width:240px;margin:0 1% 8px 0;border:1px solid #c9d3df;border-radius:4px">').join('')
      : '<span style="color:#888">Sin evidencia adjunta.</span>';
    const banda = (txt) => '<div style="background:#b91c1c;color:#fff;padding:6px 10px;font-weight:bold;margin-bottom:8px">' + txt + '</div>';
    const urgente = t.zona_riesgo === 'amenaza_inmediata' ? banda('URGENTE · AMENAZA INMEDIATA')
      : (t.escalado_en && t.clasificacion === 'Ocurrencia' ? banda('OCURRENCIA · ESCALAMIENTO INMEDIATO') : '');

    // Fondo y color explícitos: evita que el modo oscuro del cliente de correo vuelva ilegible el texto.
    return '<div style="font-family:Arial,Helvetica,sans-serif;color:#1d2330;background:#ffffff;max-width:900px;padding:12px">' +
      '<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="border-collapse:collapse;background:#ffffff;color:#1d2330">' +
      '<tr><td style="background:' + this.COLOR + ';color:#fff;padding:14px 16px;font-size:18px;font-weight:bold">' + this.esc(CONFIG.EMPRESA.toUpperCase()) + (sv ? ' — REPORTE DE SEGURIDAD VIAL' : ' — REPORTE DE INCIDENCIA') +
        '<div style="font-size:12px;font-weight:normal;opacity:.85;margin-top:2px">Folio ' + this.esc(t.folio) + ' · ' + this.esc(t.categoria) +
        (t.circuito ? ' · Circuito ' + this.esc(t.circuito) : '') + '</div></td></tr>' +
      '<tr><td style="padding:14px 0 4px;font-size:14px">' + urgente + (sv ? 'Buen día, Seguridad Vial reporta la siguiente conducta de riesgo detectada en cámara, con la investigación y evidencias, para su conocimiento y las acciones que correspondan:'
        : 'Buen día, se reporta la siguiente incidencia para su conocimiento y seguimiento:') + '</td></tr>' +
      this.seccion(sv ? '▌ DATOS DEL EVENTO' : '▌ DATOS DE LA INCIDENCIA') +
      '<tr><td><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">' + grid(fila1) + grid(fila2) + '</table></td></tr>' +
      this.seccion(sv ? '▌ INVESTIGACIÓN' : '▌ DESCRIPCIÓN DE LA INCIDENCIA') +
      '<tr><td style="font-size:13px;line-height:1.5;padding:4px 2px;white-space:pre-wrap">' + this.esc(t.descripcion) +
        (t.acciones ? '<br><br><b>' + (sv ? 'Acción con el conductor' : 'Acciones realizadas') + ':</b> ' + this.esc(t.acciones) : '') + video +
        (t.contacto_operador ? '<br><b>Contacto con el operador:</b> ' + this.esc(t.contacto_operador) : '') + '</td></tr>' +
      this.seccion('▌ EVIDENCIA FOTOGRÁFICA') +
      '<tr><td style="padding:4px 0">' + fotos + '</td></tr>' +
      (sv ? '<tr><td style="font-size:12px;color:#555;padding:8px 0">Reporte completo en PDF adjunto.</td></tr>'
        : '<tr><td style="font-size:12px;color:#555;padding:8px 0">SLA: primer estatus antes de las <b>' + this.hora(t.sla_primer_estatus_en) +
        '</b> · escalamiento a las <b>' + this.hora(t.sla_escalamiento_en) + '</b> (' + this.esc(t.zona_riesgo) + '). Reporte completo en PDF adjunto.</td></tr>') +
      '<tr><td style="font-size:14px;padding:14px 0 4px">Sin otro particular, quedo en espera de su seguimiento y atención a la brevedad posible.</td></tr>' +
      '<tr><td style="font-size:14px;padding:4px 0 18px">Atentamente,<br><b>' + this.esc(d.monitorista.nombre) + '</b><br><span style="color:#555;font-size:12px">' + (sv ? 'Analista de Seguridad Vial'
        : 'Monitorista · ' + this.esc(d.estacion ? d.estacion.nombre : '') + ' · Turno ' + this.esc(t.turno)) + '</span></td></tr>' +
      '<tr><td style="border-top:2px solid ' + this.COLOR + ';padding:8px 0;font-size:11px;color:#777;text-align:center">' +
        this.esc(CONFIG.EMPRESA) + ' | Sistema de Monitoreo de Incidencias | Uso Interno</td></tr>' +
      '</table></div>';
  },

  /** Reporte PDF ("Plantilla de Reporte.pdf"). Las imágenes van como data URI en e.src. */
  reporte: function (d) {
    const t = d.ticket;
    const sv = t.bandeja === 'seguridad_vial';
    const lbl = 'style="font-size:11px;color:#555;font-weight:bold;padding:5px 6px 1px;text-transform:uppercase"';
    const vl = 'style="font-size:13px;padding:0 6px 6px;border-bottom:1px solid #e1e6ed"';
    const campo = (l, v) => '<td width="50%" style="vertical-align:top"><div ' + lbl + '>' + l + '</div><div ' + vl + '>' + v + '</div></td>';
    const fila = (a, b) => '<tr>' + campo(a[0], a[1]) + (b ? campo(b[0], b[1]) : '<td></td>') + '</tr>';
    const caja = (titulo, filas) => '<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #c9d3df;border-collapse:collapse;margin-bottom:10px">' +
      '<tr><td colspan="2" style="background:' + this.COLOR + ';color:#fff;font-weight:bold;font-size:12px;padding:6px 8px">' + titulo + '</td></tr>' + filas + '</table>';
    const samsara = d.evidencias.filter((e) => e.tipo === 'samsara');
    const fotos = d.evidencias.filter((e) => e.tipo !== 'samsara');
    const img = (e, w) => '<img src="' + e.src + '" style="width:' + w + ';border:1px solid #c9d3df">';
    const gridFotos = () => {
      if (!fotos.length) return '<div style="color:#888;font-size:12px;padding:6px">Sin evidencias fotográficas.</div>';
      let html = '<table width="100%" cellpadding="4" cellspacing="0">';
      for (let i = 0; i < fotos.length; i += 3) {
        html += '<tr>' + [0, 1, 2].map((k) => '<td width="33%" style="vertical-align:top;text-align:center">' + (fotos[i + k] ? img(fotos[i + k], '100%') : '') + '</td>').join('') + '</tr>';
      }
      return html + '</table>';
    };
    const seguimiento = (d.seguimientos || []).filter((s) => ['primer_estatus', 'nota', 'escalar', 'cerrar'].indexOf(s.accion) !== -1);
    const nombresAccion = { primer_estatus: 'Primer estatus', nota: 'Nota', escalar: 'Escalamiento', cerrar: 'Cierre' };

    return '<html><head><meta charset="utf-8"></head><body style="font-family:Arial,Helvetica,sans-serif;color:#1d2330;background:#ffffff;margin:24px">' +
      '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
        '<td style="background:' + this.COLOR + ';color:#fff;padding:12px 14px;font-size:20px;font-weight:bold">' + (sv ? 'REPORTE DE SEGURIDAD VIAL No. ' : 'REPORTE DE INCIDENCIA No. ') + this.esc(t.folio) + '</td></tr>' +
        '<tr><td style="font-size:11px;color:#777;padding:4px 2px 12px">' + this.esc(CONFIG.EMPRESA) + (sv ? ' · Seguridad Vial · Generado ' : ' · Central de Monitoreo · Generado ') + this.fecha(new Date()) + ' ' + this.hora(new Date()) + '</td></tr></table>' +

      caja('DATOS GENERALES',
        fila([sv ? 'Analista' : 'Monitorista', this.val(d.monitorista.nombre)], sv ? ['Área', 'Seguridad Vial'] : ['Turno', this.val(t.turno)]) +
        fila(['Fecha de ocurrencia', this.fecha(t.fecha_ocurrencia)], ['Semana No.', this.val(t.semana)])) +

      '<table width="100%" cellpadding="0" cellspacing="0"><tr><td width="50%" style="vertical-align:top;padding-right:5px">' +
        caja('DATOS DE LA UNIDAD',
          fila(['Unidad', this.val(t.unidad_id)], ['Remolque #1', this.val(t.remolque1)]) +
          fila(['Remolque #2', this.val(t.remolque2)], ['Dolly', this.val(t.dolly)])) +
      '</td><td width="50%" style="vertical-align:top;padding-left:5px">' +
        caja('DATOS DEL CONDUCTOR',
          fila(['Conductor', this.val(t.operador)], ['Supervisor', this.val(t.supervisor)]) +
          fila(['Circuito', this.val(t.circuito)], null)) +
      '</td></tr></table>' +

      caja('DATOS DE LA INCIDENCIA',
        fila(['Tipo de incidencia', this.val(t.tipo_evento || t.categoria)], ['Cliente', this.val(t.cliente)]) +
        fila(['Lugar de incidencia', this.val(t.lugar)], ['Coordenadas', this.val(this.coords(t))]) +
        fila(['Hora', this.hora(t.fecha_ocurrencia)], ['Ruta', this.val(t.ruta)]) +
        fila(['Categoría / Zona', this.val(t.categoria + ' · ' + t.zona_riesgo)], ['Estación', this.val(d.estacion ? d.estacion.nombre : '')])) +

      caja(sv ? 'INVESTIGACIÓN' : 'DESCRIPCIÓN DE LA INCIDENCIA',
        '<tr><td colspan="2" style="font-size:13px;line-height:1.5;padding:8px;white-space:pre-wrap">' + this.esc(t.descripcion) +
        (t.acciones ? '<br><br><b>' + (sv ? 'Acción con el conductor' : 'Acciones realizadas') + ':</b> ' + this.esc(t.acciones) : '') +
        (sv && t.url_video ? '<br><b>Video del evento:</b> ' + this.esc(t.url_video) : '') +
        (t.contacto_operador ? '<br><b>Contacto con el operador:</b> ' + this.esc(t.contacto_operador) : '') + '</td></tr>') +

      caja('EVIDENCIA DE PLATAFORMA SAMSARA',
        '<tr><td colspan="2" style="padding:8px;text-align:center">' +
        (samsara.length ? samsara.map((e) => img(e, '90%')).join('<br>') : '<div style="color:#888;font-size:12px">Sin captura de Samsara.</div>') +
        (d.alarma && d.alarma.url_origen ? '<div style="font-size:11px;padding-top:4px">Evento en Samsara: ' + this.esc(d.alarma.url_origen) + '</div>' : '') + '</td></tr>') +

      caja('EVIDENCIAS FOTOGRÁFICAS', '<tr><td colspan="2" style="padding:4px">' + gridFotos() + '</td></tr>') +

      (seguimiento.length ? caja('SEGUIMIENTO',
        seguimiento.map((s) => '<tr><td colspan="2" style="font-size:12px;padding:5px 8px;border-bottom:1px solid #e1e6ed"><b>' + this.fecha(s.creado_en) + ' ' + this.hora(s.creado_en) +
          ' · ' + this.esc(nombresAccion[s.accion] || s.accion) + '</b> (' + this.esc(s.usuario) + '): ' + this.esc(s.nota) + '</td></tr>').join('')) : '') +

      '<div style="border-top:2px solid ' + this.COLOR + ';margin-top:14px;padding-top:6px;font-size:10px;color:#777;text-align:center">' +
        this.esc(CONFIG.EMPRESA) + ' | Sistema de Monitoreo de Incidencias | Uso Interno · Estatus del ticket: ' + this.esc(t.estatus) + '</div>' +
      '</body></html>';
  },
};
