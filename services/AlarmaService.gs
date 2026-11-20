/**
 * Consola de atención de alarmas (Samsara, GPS y manuales) por estación.
 *
 * Flujo de estatus de una alarma:
 *   nueva --tomar--> en_atencion --enviar ticket--> seguimiento --cerrar ticket--> cerrada
 *                         └----------descartar (falso positivo / sin novedad)----> descartada
 */
const AlarmaService = {
  /**
   * Datos de la consola para el usuario. estacionFiltro y bandejaFiltro solo aplican a supervisión.
   * Cada quien ve su área: Monitoreo (por estación) o Seguridad Vial (toda la flota).
   */
  consola: function (usuario, estacionFiltro, bandejaFiltro) {
    const mias = bandejasDeUsuario_(usuario);
    const bandejas = bandejaFiltro && mias.indexOf(bandejaFiltro) !== -1 ? [bandejaFiltro] : mias;
    const ver = (x) => bandejas.indexOf(bandejaDe_(x)) !== -1 && puedeVer_(usuario, x) &&
      (bandejaDe_(x) === 'seguridad_vial' || !estacionFiltro || !esSupervision_(usuario) || esDeEstacion_(x, estacionFiltro));
    const abiertas = DB.table('alarmas').where((a) => ['nueva', 'en_atencion'].indexOf(a.estatus) !== -1 && ver(a));

    const nuevas = abiertas.filter((a) => a.estatus === 'nueva').sort((a, b) =>
      ordenSeveridad_(a.severidad) - ordenSeveridad_(b.severidad) || new Date(a.recibida_en) - new Date(b.recibida_en));
    const enAtencion = abiertas.filter((a) => a.estatus === 'en_atencion' &&
      (esSupervision_(usuario) || a.asignado_a === usuario.login));
    // Lo que atienden los compañeros de su estación y de su grupo de apoyo (solo para ver y dejar notas)
    const companeros = esSupervision_(usuario) ? [] : abiertas.filter((a) => a.estatus === 'en_atencion' && a.asignado_a !== usuario.login)
      .sort((a, b) => new Date(a.tomada_en) - new Date(b.tomada_en));

    // Para el ticket: circuitos de la unidad (Samsara; prestadas tienen 2+) y tipo de incidencia sugerido
    if (enAtencion.length) {
      const K = (s) => CatalogoService.clave(s);
      const porAsset = {}, porEco = {};
      DB.table('unidades').where((u) => u.activo !== false).forEach((u) => {
        if (u.samsara_asset_id) porAsset[String(u.samsara_asset_id)] = u;
        porEco[K(u.economico)] = u;
      });
      const tipos = CatalogoService.tipos(true);
      enAtencion.forEach((a) => {
        const u = (a.samsara_asset_id && porAsset[String(a.samsara_asset_id)]) || porEco[K(a.unidad_id)];
        const ids = u ? String(u.circuitos_ids || u.circuito_id || '').split(';').filter(Boolean) : [];
        a.circuitos_unidad = ids;
        a.tipo_sugerido = a.tipo_id || CatalogoService.tipoSugerido(a, tipos);
      });
    }

    const ahora = new Date();
    // Escalados primero (destacados), luego por vencimiento del SLA
    const vence = (t) => (t.sla_escalamiento_en ? new Date(t.sla_escalamiento_en).getTime() : 8.64e15);   // Seguridad Vial: sin SLA, al final
    const tickets = DB.table('tickets').where((t) => t.estatus !== 'cerrado' && ver(t))
      .map((t) => Object.assign({}, t, TicketService.estadoSla(t, ahora), { bandeja: bandejaDe_(t) }))
      .sort((a, b) => (b.escalado_en ? 1 : 0) - (a.escalado_en ? 1 : 0) || vence(a) - vence(b) || new Date(a.creado_en) - new Date(b.creado_en));

    // Para el formulario del ticket: datos previos de la unidad y evidencias ya subidas
    const previosTodos = enAtencion.length ? ultimosDatosPorUnidad_() : {};
    const previos = {};
    enAtencion.forEach((a) => { if (previosTodos[a.unidad_id]) previos[a.unidad_id] = previosTodos[a.unidad_id]; });
    const evidencias = {};
    if (enAtencion.length) {
      const ids = {};
      enAtencion.forEach((a) => { ids[a.id] = true; });
      DB.table('evidencias').where((e) => ids[e.alarma_id] && e.estado !== 'subiendo').forEach((e) => {
        (evidencias[e.alarma_id] = evidencias[e.alarma_id] || []).push({ id: e.id, tipo: e.tipo, nombre: e.nombre, tamano: Number(e.tamano) || 0 });
      });
    }

    return {
      nuevas: nuevas, enAtencion: enAtencion, companeros: companeros, mi_estacion: usuario.estacion_id || '', tickets: tickets, previos: previos, evidencias: evidencias,
      maxFotos: CONFIG.EVIDENCIAS.MAX_FOTOS,
      limites: { maxPdfs: CONFIG.EVIDENCIAS.MAX_PDFS, maxVideos: CONFIG.EVIDENCIAS.MAX_VIDEOS, mbArchivo: CONFIG.EVIDENCIAS.MAX_MB_ARCHIVO, mbTicket: CONFIG.EVIDENCIAS.MAX_MB_TICKET },
      estaciones: DB.table('estaciones').where((e) => e.activa !== false),
      categorias: Object.keys(CONFIG.CATEGORIAS).map((c) => ({ nombre: c, areas: CONFIG.CATEGORIAS[c].areas })),
      areas: DB.table('areas').where((a) => a.activa !== false).map((a) => a.nombre),
      zonas: CONFIG.ZONAS, resultadosDescarte: CONFIG.RESULTADOS_DESCARTE, resultadosSV: CONFIG.RESULTADOS_REVISION_SV,
      bandejas: mias, bandeja: bandejas.length === 1 ? bandejas[0] : '', nombresBandeja: CONFIG.BANDEJAS,
      metaTicketMin: CONFIG.SLA.TICKET_META_MIN,
      sync: { ultima: Parametros.get('samsara_ultima_sync'), error: Parametros.get('samsara_ultimo_error') },
      // Para reasignar: monitoristas en turno ahora y analistas de Seguridad Vial activos
      usuarios: esSupervision_(usuario) ? DB.table('turnos').where((t) => t.estatus === 'activo')
        .map((t) => ({ login: t.usuario, estacion_id: t.estacion_id, bandeja: 'monitoreo' }))
        .concat(DB.table('usuarios').where((u) => u.rol === 'Seguridad Vial' && u.activo !== false)
          .map((u) => ({ login: u.usuario, estacion_id: '', bandeja: 'seguridad_vial' }))) : [],
      ahora: ahora,
    };
  },

  /** Tomar una alarma nueva. Atómico: si otro la tomó primero, falla. */
  tomar: function (alarmaId, usuario) {
    const a = DB.table('alarmas').find(alarmaId);
    if (!a) throw new Error('Alarma no encontrada.');
    if (!puedeVer_(usuario, a)) throw new Error(bandejaDe_(a) === 'seguridad_vial' || bandejasDeUsuario_(usuario).indexOf('monitoreo') === -1
      ? 'La alarma es de otra área.' : 'La alarma pertenece a otra estación.');
    const r = DB.table('alarmas').updateIf(alarmaId, (x) => x.estatus === 'nueva', (x) => Object.assign({
      estatus: 'en_atencion', asignado_a: usuario.login, tomada_en: new Date(),
    }, this.estacionAlTomar_(x, usuario.estacion_id)));
    if (!r) throw new Error('La alarma ya fue tomada por otro monitorista.');
    bitacora_(alarmaId, null, usuario.login, 'tomar', '');
    return r;
  },

  /** Cierra sin ticket: falso positivo, sin novedad o duplicada (Seguridad Vial: sin conducta de riesgo, etc.). */
  descartar: function (alarmaId, resultado, nota, usuario) {
    const al = DB.table('alarmas').find(alarmaId);
    if (!al) throw new Error('Alarma no encontrada.');
    const validos = bandejaDe_(al) === 'seguridad_vial' ? CONFIG.RESULTADOS_REVISION_SV : CONFIG.RESULTADOS_DESCARTE;
    if (validos.indexOf(resultado) === -1) throw new Error('Resultado inválido.');
    if (!nota) throw new Error('Describe cómo se validó la alarma.');
    const r = DB.table('alarmas').updateIf(alarmaId, (x) => x.estatus === 'en_atencion' && this.esResponsable_(x, usuario), {
      estatus: 'descartada', resultado: resultado, cerrada_en: new Date(), notas: nota,
    });
    if (!r) throw new Error('Solo quien atiende la alarma (o un supervisor) puede descartarla.');
    bitacora_(alarmaId, null, usuario.login, 'descartar', resultado + ': ' + nota);
    return r;
  },

  /** Alarma reportada por llamada/radio: entra ya tomada por quien la registra. */
  registrarManual: function (datos, usuario) {
    // Modelo nuevo: tipo de incidencia del catálogo (tipo_id). Anterior: categoría de CONFIG.
    let categoria, tipoEvento, severidad;
    if (datos.tipo_id) {
      const tipo = DB.table('tipos_incidencia').find(datos.tipo_id);
      if (!tipo || tipo.activo === false) throw new Error('Tipo de incidencia inválido.');
      categoria = tipo.nombre; tipoEvento = datos.tipo_evento || tipo.nombre; severidad = tipo.severidad || 'media';
    } else {
      const cat = CONFIG.CATEGORIAS[datos.categoria];
      if (!cat) throw new Error('Categoría inválida.');
      categoria = datos.categoria; tipoEvento = datos.tipo_evento || datos.categoria; severidad = cat.severidad;
    }
    if (!datos.unidad) throw new Error('La unidad es obligatoria.');
    const unidad = buscarUnidad_(DB.table('unidades').all(), null, datos.unidad);
    const ahora = new Date();
    const mias = bandejasDeUsuario_(usuario);
    const bandeja = mias.length === 1 ? mias[0] : (datos.bandeja && mias.indexOf(datos.bandeja) !== -1 ? datos.bandeja : 'monitoreo');
    const a = DB.table('alarmas').insert({
      bandeja: bandeja,
      origen: 'manual', unidad_id: unidad ? unidad.economico : String(datos.unidad).trim().toUpperCase(),
      samsara_asset_id: unidad ? (unidad.samsara_asset_id || '') : '',
      estacion_id: unidad ? unidad.estacion_id : (usuario.estacion_id || ''),
      operador: datos.operador || (unidad ? unidad.operador : ''),
      categoria: categoria, tipo_evento: tipoEvento, severidad: severidad,
      lat: datos.lat || '', lng: datos.lng || '', direccion: datos.direccion || '',
      recibida_en: ahora, estatus: 'en_atencion', asignado_a: usuario.login, tomada_en: ahora, notas: datos.nota || '',
    });
    bitacora_(a.id, null, usuario.login, 'registrar_manual', datos.nota);
    return a;
  },

  reasignar: function (alarmaId, login, usuario) {
    if (!esSupervision_(usuario)) throw new Error('Solo supervisión puede reasignar.');
    const al = DB.table('alarmas').find(alarmaId);
    if (!al) throw new Error('Alarma no encontrada.');
    if (!puedeVer_(usuario, al)) throw new Error('La alarma es de otra área.');
    if (bandejaDe_(al) === 'seguridad_vial') {
      // Seguridad Vial no tiene turnos: cualquier analista activo
      const dest = DB.table('usuarios').where((u) => u.usuario === login && u.activo !== false)[0];
      if (!dest || dest.rol !== 'Seguridad Vial') throw new Error(login + ' no es analista de Seguridad Vial.');
    }
    let estacionDestino = '';
    if (bandejaDe_(al) !== 'seguridad_vial') {
      const turno = DB.table('turnos').where((t) => t.estatus === 'activo' && t.usuario === login)[0];
      if (!turno) throw new Error(login + ' no tiene un turno activo.');
      estacionDestino = turno.estacion_id;
    }
    const r = DB.table('alarmas').updateIf(alarmaId, (x) => ['nueva', 'en_atencion'].indexOf(x.estatus) !== -1, (x) => Object.assign({
      estatus: 'en_atencion', asignado_a: login, tomada_en: x.tomada_en || new Date(),
    }, this.estacionAlTomar_(x, estacionDestino)));
    if (!r) throw new Error('La alarma ya no está abierta.');
    bitacora_(alarmaId, null, usuario.login, 'reasignar', 'a ' + login);
    return r;
  },

  agregarNota: function (alarmaId, ticketId, nota, usuario) {
    if (!nota) throw new Error('La nota está vacía.');
    bitacora_(alarmaId, ticketId, usuario.login, 'nota', nota);
    return true;
  },

  historial: function (alarmaId) {
    return DB.table('seguimientos').where((s) => s.alarma_id === alarmaId)
      .sort((a, b) => new Date(a.creado_en) - new Date(b.creado_en));
  },

  /** Alarma que ven varias estaciones: se queda con la estación de quien la toma (o la primera de la lista). */
  estacionAlTomar_: function (alarma, estacionId) {
    const lista = estacionesDe_(alarma);
    if (!lista.length || alarma.estacion_id) return {};
    // La de quien la toma; si no está en la lista, la de su grupo de apoyo que sí esté; si no, la primera
    const propia = estacionesDelGrupo_(estacionId).filter((e) => lista.indexOf(e) !== -1)[0];
    return { estacion_id: propia || lista[0] };
  },

  esResponsable_: function (alarma, usuario) {
    return esSupervision_(usuario) || alarma.asignado_a === usuario.login;
  },
};
