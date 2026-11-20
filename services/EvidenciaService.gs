/**
 * Evidencias de una alarma/ticket: 1 captura de la plataforma Samsara, fotos (comprimidas en el navegador)
 * y anexos PDF y video (subidos por partes). Límites en CONFIG.EVIDENCIAS (editables en Parámetros).
 * Se suben ANTES de enviar el ticket (quedan ligadas a la alarma) y se pueden agregar después.
 */
const EvidenciaService = {
  MB: 1048576,
  mb_: function (b) { return (Number(b || 0) / 1048576).toFixed(1) + ' MB'; },

  /** Alarma a la que se puede agregar evidencia. */
  alarmaAbierta_: function (alarmaId, usuario) {
    const alarma = DB.table('alarmas').find(alarmaId);
    if (!alarma) throw new Error('Alarma no encontrada.');
    if (!puedeVer_(usuario, alarma)) throw new Error('La alarma pertenece a otra estación.');
    if (['cerrada', 'descartada'].indexOf(alarma.estatus) !== -1) throw new Error('La alarma ya está cerrada.');
    return alarma;
  },

  /** Lo que cuenta para el cupo: evidencias listas y subidas en curso de las últimas 2 h. */
  delCupo_: function (alarmaId) {
    const hace = Date.now() - 2 * 3600000;
    return DB.table('evidencias').where((e) => e.alarma_id === alarmaId && (e.estado !== 'subiendo' || new Date(e.creado_en).getTime() >= hace));
  },

  /** Límites por tipo, por archivo y total por incidencia. */
  validarCupo_: function (alarmaId, tipo, tamano, nombre) {
    const E = CONFIG.EVIDENCIAS;
    const ev = this.delCupo_(alarmaId);
    if (tipo === 'pdf' || tipo === 'video') {
      const max = tipo === 'pdf' ? E.MAX_PDFS : E.MAX_VIDEOS;
      if (!max) throw new Error(tipo === 'pdf' ? 'No se permiten PDF (Parámetros).' : 'No se permiten videos (Parámetros).');
      if (ev.filter((e) => e.tipo === tipo).length >= max) throw new Error('Máximo ' + max + (tipo === 'pdf' ? ' PDF' : ' videos') + ' por incidencia.');
      if (tamano > E.MAX_MB_ARCHIVO * this.MB) throw new Error(nombre + ' pesa ' + this.mb_(tamano) + '; el máximo por archivo es ' + E.MAX_MB_ARCHIVO + ' MB.');
    }
    const usado = ev.reduce((s, e) => s + (Number(e.tamano) || 0), 0);
    if (usado + tamano > E.MAX_MB_TICKET * this.MB) {
      throw new Error('La incidencia ya tiene ' + this.mb_(usado) + ' de ' + E.MAX_MB_TICKET + ' MB; ' + nombre + ' (' + this.mb_(tamano) + ') no cabe.');
    }
  },

  limpiarNombre_: function (nombre) { return String(nombre || 'evidencia').replace(/[^\w.\-]+/g, '_').slice(0, 60); },

  subir: function (alarmaId, tipo, nombre, mime, base64, usuario) {
    if (['samsara', 'foto'].indexOf(tipo) === -1) throw new Error('Tipo de evidencia inválido.');
    if (CONFIG.EVIDENCIAS.TIPOS.indexOf(mime) === -1) throw new Error('Solo se aceptan imágenes JPG o PNG.');
    if (!base64 || base64.length * 0.75 > CONFIG.EVIDENCIAS.MAX_BYTES) throw new Error('La imagen es demasiado grande (máx. ' + Math.round(CONFIG.EVIDENCIAS.MAX_BYTES / 1048576) + ' MB).');
    const alarma = this.alarmaAbierta_(alarmaId, usuario);
    const tamano = Math.round(base64.length * 0.75);
    this.validarCupo_(alarmaId, tipo, tamano, nombre || 'la imagen');

    const actuales = this.deAlarma(alarmaId).filter((e) => e.tipo === tipo).length;
    const max = tipo === 'samsara' ? CONFIG.EVIDENCIAS.MAX_SAMSARA : CONFIG.EVIDENCIAS.MAX_FOTOS;
    if (actuales >= max) throw new Error('Máximo ' + max + (tipo === 'samsara' ? ' captura de Samsara.' : ' fotos por incidencia.'));

    const limpio = this.limpiarNombre_(nombre);
    const nombreArchivo = (alarma.unidad_id || 'unidad') + '_' + tipo + '_' + Date.now() + '_' + limpio;
    const archivoId = Archivos.guardar(base64, mime, nombreArchivo);
    const e = DB.table('evidencias').insert({
      alarma_id: alarmaId, ticket_id: alarma.ticket_id || '', tipo: tipo, nombre: limpio, mime: mime,
      archivo_id: archivoId, subido_por: usuario.login, creado_en: new Date(), tamano: tamano, estado: '',
    });
    bitacora_(alarmaId, alarma.ticket_id || '', usuario.login, 'evidencia', tipo + ': ' + limpio);
    return e;
  },

  /**
   * Inicia la subida por partes de un PDF o video: valida tipo, tamaño y cupo, y abre la sesión en el almacenamiento.
   * Devuelve { id, parte_bytes }. El navegador manda luego las partes con subirParte.
   */
  iniciarAnexo: function (alarmaId, tipo, nombre, mime, tamano, usuario) {
    const E = CONFIG.EVIDENCIAS;
    if (['pdf', 'video'].indexOf(tipo) === -1) throw new Error('Tipo de anexo inválido.');
    const tipos = tipo === 'pdf' ? E.TIPOS_PDF : E.TIPOS_VIDEO;
    if (tipos.indexOf(mime) === -1) throw new Error(tipo === 'pdf' ? 'Solo se aceptan archivos PDF.' : 'Solo se aceptan videos MP4 o MOV.');
    tamano = Number(tamano);
    if (!tamano || tamano < 1) throw new Error('El archivo está vacío.');
    const alarma = this.alarmaAbierta_(alarmaId, usuario);
    const limpio = this.limpiarNombre_(nombre);
    this.validarCupo_(alarmaId, tipo, tamano, limpio);
    const sesion = Archivos.iniciarSubida((alarma.unidad_id || 'unidad') + '_' + tipo + '_' + Date.now() + '_' + limpio, mime, tamano);
    const e = DB.table('evidencias').insert({
      alarma_id: alarmaId, ticket_id: alarma.ticket_id || '', tipo: tipo, nombre: limpio, mime: mime, archivo_id: '',
      subido_por: usuario.login, creado_en: new Date(), tamano: tamano, estado: 'subiendo',
    });
    Archivos.guardarSesion(e.id, sesion);
    return { id: e.id, parte_bytes: E.PARTE_BYTES };
  },

  /** Recibe la parte `indice` (base64). Al llegar la última, el anexo queda listo. */
  subirParte: function (evidenciaId, indice, base64, usuario) {
    const e = DB.table('evidencias').find(evidenciaId);
    if (!e || e.estado !== 'subiendo') throw new Error('Esa subida ya no está en curso.');
    if (e.subido_por !== usuario.login) throw new Error('Solo quien inició la subida puede continuarla.');
    const sesion = Archivos.sesion(e.id);
    if (!sesion) throw new Error('La subida expiró; vuelve a intentarlo.');
    const inicio = Number(indice) * CONFIG.EVIDENCIAS.PARTE_BYTES;
    if (!(inicio >= 0) || inicio >= Number(e.tamano)) throw new Error('Parte inválida.');
    const r = Archivos.subirParte(sesion, inicio, base64, Number(e.tamano));
    if (!r.listo) return { listo: false };
    DB.table('evidencias').update(e.id, { archivo_id: r.archivoId, estado: '' });
    bitacora_(e.alarma_id, e.ticket_id || '', usuario.login, 'evidencia', e.tipo + ': ' + e.nombre + ' (' + this.mb_(e.tamano) + ')');
    return { listo: true, id: e.id, tipo: e.tipo, nombre: e.nombre };
  },

  deAlarma: function (alarmaId) {
    return DB.table('evidencias').where((e) => e.alarma_id === alarmaId && e.estado !== 'subiendo')
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
