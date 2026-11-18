/**
 * Evidencias de una alarma/ticket: 1 captura de la plataforma Samsara + hasta 15 fotos.
 * Se suben ANTES de enviar el ticket (quedan ligadas a la alarma) y se pueden agregar después.
 */
const EvidenciaService = {
  subir: function (alarmaId, tipo, nombre, mime, base64, usuario) {
    if (['samsara', 'foto'].indexOf(tipo) === -1) throw new Error('Tipo de evidencia inválido.');
    if (CONFIG.EVIDENCIAS.TIPOS.indexOf(mime) === -1) throw new Error('Solo se aceptan imágenes JPG o PNG.');
    if (!base64 || base64.length * 0.75 > CONFIG.EVIDENCIAS.MAX_BYTES) throw new Error('La imagen es demasiado grande (máx. ' + Math.round(CONFIG.EVIDENCIAS.MAX_BYTES / 1048576) + ' MB).');
    const alarma = DB.table('alarmas').find(alarmaId);
    if (!alarma) throw new Error('Alarma no encontrada.');
    if (!puedeVer_(usuario, alarma)) throw new Error('La alarma pertenece a otra estación.');
    if (['cerrada', 'descartada'].indexOf(alarma.estatus) !== -1) throw new Error('La alarma ya está cerrada.');

    const actuales = this.deAlarma(alarmaId).filter((e) => e.tipo === tipo).length;
    const max = tipo === 'samsara' ? CONFIG.EVIDENCIAS.MAX_SAMSARA : CONFIG.EVIDENCIAS.MAX_FOTOS;
    if (actuales >= max) throw new Error('Máximo ' + max + (tipo === 'samsara' ? ' captura de Samsara.' : ' fotos por incidencia.'));

    const limpio = String(nombre || 'evidencia').replace(/[^\w.\-]+/g, '_').slice(0, 60);
    const nombreArchivo = (alarma.unidad_id || 'unidad') + '_' + tipo + '_' + Date.now() + '_' + limpio;
    const archivoId = Archivos.guardar(base64, mime, nombreArchivo);
    const e = DB.table('evidencias').insert({
      alarma_id: alarmaId, ticket_id: alarma.ticket_id || '', tipo: tipo, nombre: limpio, mime: mime,
      archivo_id: archivoId, subido_por: usuario.login, creado_en: new Date(),
    });
    bitacora_(alarmaId, alarma.ticket_id || '', usuario.login, 'evidencia', tipo + ': ' + limpio);
    return e;
  },

  deAlarma: function (alarmaId) {
    return DB.table('evidencias').where((e) => e.alarma_id === alarmaId)
      .sort((a, b) => (a.tipo === 'samsara' ? -1 : 0) - (b.tipo === 'samsara' ? -1 : 0) || new Date(a.creado_en) - new Date(b.creado_en));
  },

  /** Liga al ticket las evidencias que se subieron mientras la alarma estaba en atención. */
  vincular: function (alarmaId, ticketId) {
    const patches = {};
    this.deAlarma(alarmaId).filter((e) => !e.ticket_id).forEach((e) => { patches[e.id] = { ticket_id: ticketId }; });
    return DB.table('evidencias').updateMany(patches);
  },

  eliminar: function (evidenciaId, usuario) {
    const e = DB.table('evidencias').find(evidenciaId);
    if (!e) throw new Error('Evidencia no encontrada.');
    const alarma = DB.table('alarmas').find(e.alarma_id) || {};
    if (!esSupervision_(usuario) && e.subido_por !== usuario.login) throw new Error('Solo quien la subió o supervisión puede quitarla.');
    if (alarma.ticket_id && !esSupervision_(usuario)) throw new Error('El ticket ya se envió; pide a supervisión que la quite.');
    DB.table('evidencias').updateMany({ [e.id]: { alarma_id: 'eliminada:' + e.alarma_id, ticket_id: '' } });
    bitacora_(e.alarma_id, e.ticket_id, usuario.login, 'evidencia_eliminada', e.nombre);
    return true;
  },
};
