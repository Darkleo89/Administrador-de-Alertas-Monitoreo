/**
 * Envío de tickets y escalamientos por correo (MailApp).
 * Con la web app ejecutándose como el usuario que accede, el correo sale de la cuenta del monitorista.
 * En producción se reemplaza por un servicio SMTP/API con la misma interfaz.
 */
const NotificationService = {
  /**
   * Ticket con el formato de "Platilla para Correo.pdf" (Plantillas.correo), fotos en línea
   * y el reporte PDF adjunto. remitente = { nombre, login, email } del monitorista.
   */
  enviarTicket: function (ticket, alarma, destinatarios, remitente) {
    remitente = remitente || {};
    const p = ReporteService.paqueteCorreo(ticket.id);
    const t = p.datos.ticket;
    const urgente = t.zona_riesgo === 'amenaza_inmediata' ? '[URGENTE] ' : '';
    const texto = [
      CONFIG.EMPRESA + ' — REPORTE DE INCIDENCIA (' + t.folio + ')',
      'Fecha: ' + Plantillas.fecha(t.fecha_ocurrencia) + '  Hora: ' + Plantillas.hora(t.fecha_ocurrencia) + '  Semana: ' + t.semana,
      'Unidad: ' + t.unidad_id + '  Conductor: ' + (t.operador || '-') + '  Ruta: ' + (t.ruta || '-'),
      'Incidencia: ' + (t.tipo_evento || t.categoria) + '  Lugar: ' + (t.lugar || '-'),
      '', t.descripcion, '', 'Atentamente, ' + p.datos.monitorista.nombre,
    ].join('\n');
    const opciones = remitente.email ? { replyTo: remitente.email } : {};
    MailApp.sendEmail(Object.assign(opciones, {
      name: t.bandeja === 'seguridad_vial' ? 'Seguridad Vial GAL' : 'Monitoreo GAL',
      to: destinatarios.join(','),
      subject: t.tipo_id || t.bandeja === 'seguridad_vial' ? Plantillas.asunto(t) : urgente + '[' + t.folio + '] Reporte de incidencia · ' + (t.tipo_evento || t.categoria) + ' · Unidad ' + t.unidad_id,
      htmlBody: p.html,
      body: texto,
      inlineImages: p.inlineImages,
      attachments: p.adjuntos,
    }));
  },

  enviarEscalamiento: function (ticket, motivo, destinatarios) {
    if (ticket.tipo_id) {
      // Modelo nuevo: el mismo correo del ticket, a la misma lista, con banda roja de ESCALADO y el motivo.
      const p = ReporteService.paqueteCorreo(ticket.id);
      const banda = '<div style="font-family:Arial,sans-serif;background:#b91c1c;color:#fff;padding:12px 16px;font-size:16px;font-weight:bold;max-width:900px">' +
        '⚠ TICKET ESCALADO — requiere atención inmediata<div style="font-size:13px;font-weight:normal;margin-top:4px">Motivo: ' + this.esc_(motivo) +
        ' · Primer estatus: ' + (ticket.primer_estatus_en ? this.fmt_(ticket.primer_estatus_en) : 'SIN REGISTRAR') + '</div></div>';
      MailApp.sendEmail({
        name: 'Monitoreo GAL', to: destinatarios.join(','),
        subject: '[ESCALADO] ' + Plantillas.asunto(p.datos.ticket),
        htmlBody: banda + p.html, body: 'TICKET ESCALADO. Motivo: ' + motivo + '\n\n' + Plantillas.asunto(p.datos.ticket),
        inlineImages: p.inlineImages, attachments: p.adjuntos,
      });
      return;
    }
    const filas = [
      ['Folio', ticket.folio], ['Motivo', motivo], ['Categoría', ticket.categoria],
      ['Unidad', ticket.unidad_id], ['Zona', ticket.zona_riesgo], ['Monitorista', ticket.monitorista],
      ['Primer estatus', ticket.primer_estatus_en ? this.fmt_(ticket.primer_estatus_en) : 'SIN REGISTRAR'],
      ['Ubicación', this.mapa_(ticket.lat, ticket.lng)],
    ];
    MailApp.sendEmail({
      name: 'Monitoreo GAL',
      to: destinatarios.join(','),
      subject: '[ESCALAMIENTO] [' + ticket.folio + '] ' + ticket.categoria + ' - Unidad ' + ticket.unidad_id,
      htmlBody: this.html_('Escalamiento de incidencia', filas),
      body: filas.map((f) => f[0] + ': ' + String(f[1]).replace(/<[^>]+>/g, '')).join('\n'),
    });
  },

  esc_: function (v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  },
  mapa_: function (lat, lng, dir) {
    if (!lat || !lng) return this.esc_(dir || 'Sin coordenadas');
    return '<a href="https://maps.google.com/?q=' + lat + ',' + lng + '">' + this.esc_(dir || (lat + ', ' + lng)) + '</a>';
  },
  fmt_: function (d) {
    return d ? Utilities.formatDate(new Date(d), CONFIG_TZ_(), 'dd/MM/yyyy HH:mm') : '-';
  },
  html_: function (titulo, filas) {
    const safe = (k, v) => (['Ubicación', 'Evidencia Samsara'].indexOf(k) !== -1 ? v : this.esc_(v));
    return '<div style="font-family:Arial,sans-serif;font-size:14px">' +
      '<h2 style="color:#1f4e79;margin:0 0 8px">' + this.esc_(titulo) + '</h2>' +
      '<table cellpadding="6" style="border-collapse:collapse">' +
      filas.map((f) => '<tr><td style="border:1px solid #ddd;background:#f5f7fa;font-weight:bold">' + this.esc_(f[0]) +
        '</td><td style="border:1px solid #ddd">' + safe(f[0], f[1]) + '</td></tr>').join('') +
      '</table><p style="color:#888;font-size:12px">Generado por Monitoreo de Flota GAL</p></div>';
  },
};
