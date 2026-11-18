/**
 * Tickets de incidencia: envío a las áreas responsables, SLA, seguimiento, escalamiento y cierre.
 * Estatus del ticket: abierto -> en_seguimiento -> (escalado) -> cerrado
 */
const TicketService = {
  /** Vencimientos SLA. Se cuentan desde que se recibió la alarma ("reporte inicial"). */
  /**
   * Vencimientos SLA a partir de `desde` (el envío del ticket).
   * por = { primerMin, escalMin, inmediato } del tipo de incidencia (si el Admin los definió).
   */
  calcularSla: function (desde, zonaRiesgo, ahora, por) {
    por = por || {};
    const base = new Date(desde || ahora).getTime();
    let escMin = CONFIG.SLA.ESCALAMIENTO_ZONA_SEGURA_MIN;
    if (zonaRiesgo === 'alta') escMin = CONFIG.SLA.ESCALAMIENTO_ALTO_RIESGO_MIN;
    if (Number(por.escalMin) > 0) escMin = Number(por.escalMin);
    const primerMin = Number(por.primerMin) > 0 ? Number(por.primerMin) : CONFIG.SLA.PRIMER_ESTATUS_MIN;
    const inmediato = zonaRiesgo === 'amenaza_inmediata' || por.inmediato === true;
    return {
      sla_primer_estatus_en: new Date(base + primerMin * 60000),
      sla_escalamiento_en: inmediato ? new Date(ahora) : new Date(base + escMin * 60000),
    };
  },

  /**
   * Destinatarios y datos de clasificación de un ticket.
   *  - Modelo nuevo (form.tipo_id): tipo de incidencia + circuito -> lista(s) de distribución, o respaldo.
   *  - Modelo anterior (form.categoria): categoría -> áreas (tickets creados antes del cambio).
   */
  clasificar_: function (form, alarma) {
    if (form.tipo_id) {
      const tipo = DB.table('tipos_incidencia').find(form.tipo_id);
      if (!tipo || tipo.activo === false) throw new Error('Selecciona el tipo de incidencia.');
      const circ = form.circuito_id ? DB.table('circuitos').find(form.circuito_id) : null;
      if (!circ || circ.activo === false) throw new Error('Selecciona el circuito de la unidad.');
      const dest = CatalogoService.destinatarios(circ.id, tipo.id);
      return {
        destinatarios: dest.correos, descripcionDestino: dest.listas.join(', '),
        sla: { primerMin: tipo.sla_primer_estatus_min, escalMin: tipo.sla_escalamiento_min, inmediato: tipo.escalamiento_inmediato === true },
        campos: {
          categoria: tipo.nombre, tipo_evento: tipo.nombre, tipo_id: tipo.id, clasificacion: tipo.clasificacion || 'Incidencia',
          severidad: tipo.severidad || '', circuito_id: circ.id, circuito: circ.nombre,
          listas: dest.listas.join(', '), respaldo: dest.respaldo === true, areas: '',
        },
      };
    }
    const cat = CONFIG.CATEGORIAS[form.categoria];
    if (!cat) throw new Error('Selecciona una categoría válida.');
    const areas = cat.areas.concat((form.areas_extra || []).filter((a) => cat.areas.indexOf(a) === -1));
    return {
      destinatarios: this.resolverDestinatarios(areas), descripcionDestino: areas.join(', ') + ' (hoja "areas")', sla: {},
      campos: { categoria: form.categoria, tipo_evento: form.tipo_evento || alarma.tipo_evento, areas: areas.join(', '),
        circuito: String(form.circuito || '').trim().slice(0, 200) },
    };
  },

  /** Correos actuales de un ticket ya creado (para reenviar o escalar). */
  destinatariosDe_: function (t) {
    if (bandejaDe_(t) === 'seguridad_vial') return CatalogoService.correos_(CatalogoService.listaSeguridadVial());
    if (t.tipo_id && t.circuito_id) return CatalogoService.destinatarios(t.circuito_id, t.tipo_id).correos;
    return this.resolverDestinatarios(String(t.areas || '').split(/,\s*/).filter(Boolean));
  },

  /** Estado SLA calculado para mostrar en consola. */
  estadoSla: function (t, ahora) {
    if (bandejaDe_(t) === 'seguridad_vial' || !t.sla_escalamiento_en) return { sla: 'sin_sla' };   // Seguridad Vial no tiene SLA
    const now = new Date(ahora).getTime();
    let sla = 'en_tiempo';
    if (!t.primer_estatus_en && now > new Date(t.sla_primer_estatus_en).getTime()) sla = 'primer_estatus_vencido';
    if (now > new Date(t.sla_escalamiento_en).getTime()) sla = 'escalar';
    if (t.escalado_en) sla = 'escalado';
    return { sla: sla };
  },

  generarFolio: function (fecha, prefijo) {
    const dia = Utilities.formatDate(fecha, CONFIG_TZ_(), 'yyyyMMdd');
    const sv = prefijo === CONFIG.FOLIO_PREFIJO_SV;
    const n = Parametros.siguiente((sv ? 'folio_sv_' : 'folio_') + dia);
    return (prefijo || CONFIG.FOLIO_PREFIJO) + '-' + dia + '-' + String(n).padStart(4, '0');
  },

  /** Correos de destino a partir de las áreas (hoja `areas`). */
  resolverDestinatarios: function (areas) {
    const catalogo = DB.table('areas').all();
    const emails = [];
    areas.forEach((nombre) => {
      const a = catalogo.find((x) => x.activa !== false && String(x.nombre).toLowerCase() === String(nombre).toLowerCase());
      String((a && a.emails) || '').split(/[,;\s]+/).filter(Boolean).forEach((e) => { if (emails.indexOf(e) === -1) emails.push(e); });
    });
    return emails;
  },

  /**
   * Botón "Enviar ticket": crea el ticket desde una alarma en atención y lo envía por correo.
   * form = { tipo_id, circuito_id, zona_riesgo, descripcion, acciones, contacto_operador,
   *          operador, remolque1, remolque2, dolly, ruta, operacion, cliente, supervisor, lugar }
   *        (modelo anterior: categoria, tipo_evento, areas_extra[], circuito en lugar de tipo_id/circuito_id)
   * Las evidencias (fotos) se suben antes con EvidenciaService.subir y aquí se ligan al ticket.
   * Lo escrito en cliente, supervisor, conductor, remolques, dolly y ruta que no exista en su catálogo
   * se agrega como "Por validar" (devuelto en ticket.por_validar).
   */
  enviar: function (alarmaId, form, usuario) {
    const alarma = DB.table('alarmas').find(alarmaId);
    if (!alarma) throw new Error('Alarma no encontrada.');
    if (alarma.ticket_id) throw new Error('Esta alarma ya tiene ticket.');
    if (alarma.estatus !== 'en_atencion') throw new Error('Primero toma la alarma.');
    if (!AlarmaService.esResponsable_(alarma, usuario)) throw new Error('La alarma está asignada a ' + alarma.asignado_a + '.');
    if (!puedeVer_(usuario, alarma)) throw new Error('La alarma es de otra área.');
    if (bandejaDe_(alarma) === 'seguridad_vial') return this.enviarSeguridadVial_(alarma, form, usuario);
    const cls = this.clasificar_(form, alarma);
    if (CONFIG.ZONAS.indexOf(form.zona_riesgo) === -1) throw new Error('Selecciona la zona de riesgo.');
    if (!form.descripcion || String(form.descripcion).trim().length < 10) throw new Error('Describe la incidencia (mínimo 10 caracteres).');

    const destinatarios = cls.destinatarios;
    const ahora = new Date();
    // Los plazos (primer estatus y escalamiento) corren desde que se ENVÍA el ticket: miden la respuesta del área.
    // (Antes contaban desde que llegó la alarma: una alarma atendida tarde se escalaba al minuto de enviar el ticket.)
    // El tiempo del monitorista (alarma -> ticket) se mide aparte en Desempeño.
    const sla = this.calcularSla(ahora, form.zona_riesgo, ahora, cls.sla);
    const inmediato = form.zona_riesgo === 'amenaza_inmediata' || cls.sla.inmediato === true;

    // Reservar la alarma antes de crear el ticket (evita dobles tickets por doble clic).
    const reservada = DB.table('alarmas').updateIf(alarmaId, (x) => x.estatus === 'en_atencion' && !x.ticket_id, { estatus: 'seguimiento', categoria: cls.campos.categoria });
    if (!reservada) throw new Error('Esta alarma ya tiene ticket.');

    const ocurrencia = alarma.recibida_en ? new Date(alarma.recibida_en) : ahora;
    const txt = (k) => String(form[k] || '').trim().replace(/\s+/g, ' ').slice(0, 200);
    const mayus = (k) => txt(k).toUpperCase();
    let ticket = DB.table('tickets').insert(Object.assign({
      folio: this.generarFolio(ahora), alarma_id: alarma.id, estacion_id: alarma.estacion_id,
      monitorista: usuario.login, unidad_id: alarma.unidad_id, operador: (form.tipo_id ? mayus('operador') : txt('operador')) || alarma.operador || '',
      zona_riesgo: form.zona_riesgo,
      descripcion: form.descripcion, acciones: form.acciones || '', contacto_operador: form.contacto_operador || '',
      destinatarios: destinatarios.join(', '), lat: alarma.lat, lng: alarma.lng,
      creado_en: ahora, estatus: inmediato ? 'escalado' : 'abierto', escalado_en: inmediato ? ahora : '',
      // Campos de las plantillas de correo/reporte
      fecha_ocurrencia: ocurrencia, semana: semanaIso_(ocurrencia), turno: TurnoService.turnoDeHora(ocurrencia).nombre,
      remolque1: mayus('remolque1'), remolque2: mayus('remolque2'), dolly: mayus('dolly'), ruta: mayus('ruta'),
      operacion: mayus('operacion'), cliente: mayus('cliente'), supervisor: mayus('supervisor'), lugar: txt('lugar') || alarma.direccion || '',
    }, cls.campos, sla));
    DB.table('alarmas').update(alarma.id, { ticket_id: ticket.id });
    EvidenciaService.vincular(alarma.id, ticket.id);

    // Catálogos: lo escrito que no existe queda "Por validar"
    const porValidar = [];
    if (form.tipo_id) {
      const existentes = DB.table('catalogos').all();
      [['cliente', ticket.cliente], ['cliente', ticket.operacion], ['supervisor', ticket.supervisor], ['conductor', ticket.operador],
       ['remolque', ticket.remolque1], ['remolque', ticket.remolque2], ['dolly', ticket.dolly], ['ruta', ticket.ruta]]
        .forEach((p) => {
          if (CatalogoService.registrarSiNuevo(p[0], p[1], ticket.circuito_id, usuario.login, existentes)) porValidar.push(p[0] + ': ' + p[1]);
        });
      if (porValidar.length) bitacora_(alarma.id, ticket.id, usuario.login, 'por_validar', porValidar.join(' · '));
    }

    try {
      if (!destinatarios.length) throw new Error('Sin correos configurados para: ' + cls.descripcionDestino + '.');
      NotificationService.enviarTicket(ticket, alarma, destinatarios, usuario);
      ticket = DB.table('tickets').update(ticket.id, { enviado_en: new Date(), envio_error: '' });
    } catch (e) {
      ticket = DB.table('tickets').update(ticket.id, { envio_error: e.message });
    }
    bitacora_(alarma.id, ticket.id, usuario.login, 'enviar_ticket', ticket.folio + ' → ' + cls.descripcionDestino +
      (ticket.respaldo === true ? ' (sin lista para este circuito y tipo: lista de respaldo)' : '') +
      (ticket.envio_error ? ' (ERROR envío: ' + ticket.envio_error + ')' : ''));
    return Object.assign({}, ticket, { por_validar: porValidar });
  },

  /**
   * Seguridad Vial: reporte de una conducta de riesgo comprobada (investigación + evidencias + video).
   * Va a la "Lista Seguridad Vial" (gerentes de operaciones, RH, protección patrimonial). Sin SLA ni escalamiento.
   * form = { conducta, descripcion (investigación), acciones (acción con el conductor), operador, supervisor, lugar, url_video }
   */
  enviarSeguridadVial_: function (alarma, form, usuario) {
    const txt = (k, max) => String(form[k] || '').trim().replace(/\s+/g, ' ').slice(0, max || 200);
    const conducta = txt('conducta', 120).toUpperCase();
    if (!conducta) throw new Error('Escribe la conducta detectada.');
    if (!form.descripcion || String(form.descripcion).trim().length < 10) throw new Error('Describe la investigación (mínimo 10 caracteres).');
    const video = txt('url_video', 500);
    if (video && video.indexOf('https:' + '//') !== 0) throw new Error('El enlace del video debe empezar con https://');
    const lista = CatalogoService.listaSeguridadVial();
    const destinatarios = CatalogoService.correos_(lista);
    const ahora = new Date();
    const reservada = DB.table('alarmas').updateIf(alarma.id, (x) => x.estatus === 'en_atencion' && !x.ticket_id, { estatus: 'seguimiento' });
    if (!reservada) throw new Error('Esta alarma ya tiene reporte.');
    const ocurrencia = alarma.recibida_en ? new Date(alarma.recibida_en) : ahora;
    let ticket = DB.table('tickets').insert({
      folio: this.generarFolio(ahora, CONFIG.FOLIO_PREFIJO_SV), alarma_id: alarma.id, estacion_id: alarma.estacion_id || '',
      monitorista: usuario.login, unidad_id: alarma.unidad_id, operador: txt('operador').toUpperCase() || alarma.operador || '',
      categoria: 'SEGURIDAD VIAL', tipo_evento: conducta, clasificacion: 'Seguridad Vial', severidad: alarma.severidad || '',
      zona_riesgo: '', descripcion: form.descripcion, acciones: form.acciones || '', contacto_operador: '',
      destinatarios: destinatarios.join(', '), listas: lista.nombre, lat: alarma.lat, lng: alarma.lng,
      creado_en: ahora, estatus: 'abierto', sla_primer_estatus_en: '', sla_escalamiento_en: '', escalado_en: '',
      fecha_ocurrencia: ocurrencia, semana: semanaIso_(ocurrencia), turno: '',
      supervisor: txt('supervisor').toUpperCase(), lugar: txt('lugar') || alarma.direccion || '',
      bandeja: 'seguridad_vial', url_video: video,
    });
    DB.table('alarmas').update(alarma.id, { ticket_id: ticket.id });
    EvidenciaService.vincular(alarma.id, ticket.id);
    try {
      if (!destinatarios.length) throw new Error('La "' + lista.nombre + '" no tiene correos (Configuración → Avisos y correos → Listas y cobertura).');
      NotificationService.enviarTicket(ticket, alarma, destinatarios, usuario);
      ticket = DB.table('tickets').update(ticket.id, { enviado_en: new Date(), envio_error: '' });
    } catch (e) {
      ticket = DB.table('tickets').update(ticket.id, { envio_error: e.message });
    }
    bitacora_(alarma.id, ticket.id, usuario.login, 'enviar_ticket', ticket.folio + ' (Seguridad Vial: ' + conducta + ') → ' + lista.nombre +
      (ticket.envio_error ? ' (ERROR envío: ' + ticket.envio_error + ')' : ''));
    return Object.assign({}, ticket, { por_validar: [] });
  },

  /** Reintenta el envío de un ticket que falló (p. ej. faltaban correos en una lista). */
  reenviar: function (ticketId, usuario) {
    const t = DB.table('tickets').find(ticketId);
    this.verificarAcceso_(t, usuario);
    const alarma = DB.table('alarmas').find(t.alarma_id) || {};
    const destinatarios = this.destinatariosDe_(t);
    if (!destinatarios.length) throw new Error('Sin correos configurados para: ' + (t.listas || t.areas));
    NotificationService.enviarTicket(t, alarma, destinatarios, usuario);
    bitacora_(t.alarma_id, t.id, usuario.login, 'reenviar_ticket', destinatarios.join(', '));
    return DB.table('tickets').update(t.id, { enviado_en: t.enviado_en || new Date(), envio_error: '', destinatarios: destinatarios.join(', ') });
  },

  /**
   * Cualquier monitorista en turno en la estación del ticket puede darle seguimiento
   * (el turno entrante continúa los tickets del saliente). Supervisión puede todos.
   */
  verificarAcceso_: function (t, usuario) {
    if (!t) throw new Error('Ticket no encontrado.');
    if (!puedeVer_(usuario, t)) throw new Error(bandejaDe_(t) === 'seguridad_vial' ? 'El reporte es de Seguridad Vial.' : 'El ticket pertenece a otra estación.');
  },

  primerEstatus: function (ticketId, nota, usuario) {
    if (!nota) throw new Error('Escribe el estatus reportado.');
    this.verificarAcceso_(DB.table('tickets').find(ticketId), usuario);
    const r = DB.table('tickets').updateIf(ticketId, (t) => !t.primer_estatus_en && t.estatus !== 'cerrado', (t) => ({
      primer_estatus_en: new Date(), estatus: t.estatus === 'abierto' ? 'en_seguimiento' : t.estatus,
    }));
    if (!r) throw new Error('El ticket ya tiene primer estatus o está cerrado.');
    bitacora_(r.alarma_id, r.id, usuario.login, 'primer_estatus', nota);
    return r;
  },

  escalar: function (ticketId, motivo, quien) {
    const r = DB.table('tickets').updateIf(ticketId, (t) => !t.escalado_en && t.estatus !== 'cerrado', {
      escalado_en: new Date(), estatus: 'escalado',
    });
    if (!r) return null;
    // Modelo nuevo: a la MISMA lista del ticket (ahí están los gerentes), destacado como escalado.
    // Modelo anterior: áreas del ticket + área de escalamiento.
    const destinatarios = r.tipo_id
      ? this.destinatariosDe_(r)
      : this.resolverDestinatarios([CONFIG.AREA_ESCALAMIENTO].concat(String(r.areas).split(/,\s*/)));
    try { if (destinatarios.length) NotificationService.enviarEscalamiento(r, motivo, destinatarios); }
    catch (e) { console.error('Escalamiento sin correo: ' + e.message); }
    bitacora_(r.alarma_id, r.id, quien, 'escalar', motivo);
    return r;
  },

  cerrar: function (ticketId, conclusion, usuario) {
    if (!conclusion || conclusion.trim().length < 10) throw new Error('Escribe la conclusión (mínimo 10 caracteres).');
    const t = DB.table('tickets').find(ticketId);
    this.verificarAcceso_(t, usuario);
    const ahora = new Date();
    const r = DB.table('tickets').updateIf(ticketId, (x) => x.estatus !== 'cerrado', {
      estatus: 'cerrado', cerrado_en: ahora, cerrado_por: usuario.login, conclusion: conclusion,
    });
    if (!r) throw new Error('El ticket ya está cerrado.');
    DB.table('alarmas').update(t.alarma_id, { estatus: 'cerrada', cerrada_en: ahora, resultado: 'Incidencia atendida' });
    bitacora_(t.alarma_id, t.id, usuario.login, 'cerrar', conclusion);
    return r;
  },

  /** Job: escala automáticamente los tickets con SLA de escalamiento vencido. */
  revisarSla: function () {
    const ahora = Date.now();
    const vencidos = DB.table('tickets').where((t) => t.estatus !== 'cerrado' && !t.escalado_en && t.sla_escalamiento_en &&
      bandejaDe_(t) !== 'seguridad_vial' && ahora > new Date(t.sla_escalamiento_en).getTime());
    vencidos.forEach((t) => this.escalar(t.id, 'SLA de escalamiento vencido (' + t.zona_riesgo + ')', 'sistema'));
    return vencidos.length;
  },
};
