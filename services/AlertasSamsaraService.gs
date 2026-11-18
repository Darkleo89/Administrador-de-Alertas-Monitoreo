/**
 * Qué llega de Samsara a la consola y a qué área. Configuración → Samsara → Alertas y cámaras (solo Admin; en Samsara no se cambia nada).
 *
 *  origen 'alerta'    = alertas configuradas (Botón de pánico, Parada no autorizada, Desvío de ruta…).
 *                       Se descubren solas desde GET /alerts/configurations. configuracion_id = id de Samsara.
 *  origen 'seguridad' = eventos de cámara / IA (MobileUsage, NoSeatbelt, Passenger…). Samsara no da la lista,
 *                       así que se cargan las conocidas y se agrega cualquier etiqueta nueva que llegue.
 *                       configuracion_id = 'label:<Etiqueta de Samsara>'.
 *
 * destino (a quién le llega): monitoreo | seguridad_vial | ambos | ninguno. También: severidad y tipo sugerido.
 * manual = true: agregada por enlace. Samsara NO lista por API las alertas con algún disparador no compatible
 *   (p. ej. 1031 "Asset stops moving" de las paradas), pero sí entrega sus incidentes si se piden por id.
 * estaciones (solo alertas configuradas que llegan a Monitoreo): qué estaciones la ven, sin importar la etiqueta de la
 *   unidad (p. ej. "Parada No Autorizada Mexico" -> México). Vacío = según la estación de la unidad (como antes).
 */
const AlertasSamsaraService = {
  SEVERIDADES: ['critica', 'alta', 'media', 'baja'],
  DESTINOS: ['monitoreo', 'seguridad_vial', 'ambos', 'ninguno'],
  /** Automatizaciones de Samsara (asesoramiento, capacitación, descartes): no son alarmas para nadie. */
  NO_VIGILAR: /ASESORAMIENTO|CAPACITACION|COACHING|DESCARTAR|ENTRENAMIENTO/,
  PREFIJO_ETIQUETA: 'label:',

  /**
   * Etiquetas de eventos de seguridad conocidas: [etiqueta, nombre en español, severidad, destino].
   * Conducta de manejo -> Seguridad Vial. Monitoreo recibe lo operativo (pasajero, cámara obstruida) y las colisiones.
   */
  ETIQUETAS_SEGURIDAD: [
    ['Crash', 'Colisión', 'critica', 'ambos'],
    ['NearCollison', 'Casi colisión', 'alta', 'seguridad_vial'],
    ['ForwardCollisionWarning', 'Advertencia de colisión frontal', 'alta', 'seguridad_vial'],
    ['MobileUsage', 'Uso de celular', 'alta', 'seguridad_vial'],
    ['ObstructedCamera', 'Cámara obstruida', 'alta', 'monitoreo'],
    ['Passenger', 'Pasajero a bordo', 'media', 'monitoreo'],
    ['Drowsy', 'Somnolencia', 'alta', 'seguridad_vial'],
    ['Inattentive', 'Distracción', 'alta', 'seguridad_vial'],
    ['GenericDistraction', 'Distracción', 'alta', 'seguridad_vial'],
    ['EdgeDistractedDriving', 'Conducción distraída', 'alta', 'seguridad_vial'],
    ['NoSeatbelt', 'Sin cinturón de seguridad', 'alta', 'seguridad_vial'],
    ['EdgeRailroadCrossingViolation', 'Cruce de vías del tren sin precaución', 'alta', 'seguridad_vial'],
    ['Smoking', 'Fumando', 'media', 'seguridad_vial'],
    ['Drinking', 'Bebiendo', 'media', 'seguridad_vial'],
    ['Eating', 'Comiendo', 'baja', 'seguridad_vial'],
    ['RollingStop', 'Alto sin detenerse por completo', 'media', 'seguridad_vial'],
    ['DidNotYield', 'No cedió el paso', 'media', 'seguridad_vial'],
    ['Speeding', 'Exceso de velocidad', 'media', 'seguridad_vial'],
    ['MaxSpeed', 'Velocidad máxima excedida', 'media', 'seguridad_vial'],
    ['FollowingDistance', 'Distancia de seguimiento corta', 'media', 'seguridad_vial'],
    ['LaneDeparture', 'Salida de carril', 'media', 'seguridad_vial'],
    ['Acceleration', 'Aceleración brusca', 'media', 'seguridad_vial'],
    ['Braking', 'Frenado brusco', 'media', 'seguridad_vial'],
    ['HarshTurn', 'Giro brusco', 'media', 'seguridad_vial'],
    ['LateResponse', 'Respuesta tardía', 'baja', 'seguridad_vial'],
    ['DefensiveDriving', 'Conducción defensiva (positivo)', 'baja', 'ninguno'],
  ],

  /** Disparadores de Samsara (triggerTypeId) que la API sí entrega, para mostrar en la última lectura. */
  DISPARADORES: {
    1000: 'Velocidad', 1003: 'Temperatura', 1005: 'Nivel de combustible', 1006: 'Nivel de DEF', 1007: 'Batería',
    1009: 'Gateway desconectado', 1012: 'Cámara desconectada', 1046: 'Conector de cámara desconectado',
    1013: 'Unidad empieza a moverse', 1014: 'Dentro de geocerca', 1020: 'Fuera de geocerca', 1016: 'Manejo sin asignar',
    1018: 'Violación HOS', 1019: 'Ralentí', 1021: 'Motor encendido', 1022: 'Motor apagado', 1023: 'Evento brusco',
    1024: 'Mantenimiento', 1025: 'Mantenimiento por odómetro', 1026: 'Mantenimiento por horas de motor',
    1027: 'Fuera de ruta', 1032: 'Pérdida de GPS', 1033: 'Pérdida de señal celular', 1029: 'Código de falla',
    1043: 'Fallas de llantas', 1030: 'Gateway sin conexión', 1034: 'Botón de pánico', 1045: 'Manipulación detectada',
    1062: 'Lectura del activo', 5022: 'Exceso de velocidad grave', 5005: 'DVIR enviado', 5009: 'Documento del conductor',
    5012: 'Inicio de sesión del conductor', 5013: 'Cierre de sesión del conductor', 5016: 'Entrada a geocerca',
    5017: 'Salida de geocerca', 5018: 'ETA de parada', 5027: 'Grabación del conductor',
    5033: 'Evento de seguridad (con conductor)', 5039: 'Evento de seguridad', 5034: 'Subida de combustible',
    5035: 'Caída de combustible', 8001: 'Fecha y hora programada', 8003: 'Capacitación por vencer',
    8004: 'Capacitación vencida', 8014: 'Asignación vencida',
  },

  K_: function (s) { return CatalogoService.clave(s); },
  /** Ids de estación de una fila (alerta o alarma). */
  estacionesDe: function (a) {
    return String((a && a.estaciones) || '').split(';').map((x) => x.trim()).filter(Boolean);
  },
  /** Disparadores de una configuración de Samsara, en texto. */
  disparadores_: function (c) {
    return (c.triggers || []).map((t) => {
      const id = t && (t.type !== undefined ? t.type : t.triggerTypeId);
      return this.DISPARADORES[id] || ('Disparador ' + (id === undefined ? '?' : id));
    }).join(', ');
  },
  esSeguridad_: function (a) { return a.origen === 'seguridad'; },

  /** Destino de una fila (las anteriores al cambio solo tenían vigilar sí/no = Monitoreo). */
  destinoDe: function (a) {
    if (a && this.DESTINOS.indexOf(a.destino) !== -1) return a.destino;
    return a && a.vigilar === true ? 'monitoreo' : 'ninguno';
  },
  /** Áreas (bandejas) que reciben un destino. */
  bandejasDe: function (destino) {
    if (destino === 'ambos') return ['monitoreo', 'seguridad_vial'];
    if (destino === 'monitoreo' || destino === 'seguridad_vial') return [destino];
    return [];
  },
  /** ¿Alguna alerta o evento llega a esta área? (Seguridad Vial obliga a leer toda la flota). */
  hayDestino: function (bandeja) {
    return DB.table('alertas_samsara').all().some((a) => a.en_samsara !== false && a.habilitada_samsara !== false &&
      this.bandejasDe(this.destinoDe(a)).indexOf(bandeja) !== -1);
  },

  /** Severidad sugerida por el nombre de la alerta (el Admin la puede cambiar). */
  severidadSugerida: function (nombre) {
    const k = this.K_(nombre);
    if (/PANICO|PANIC|ROBO|ASALTO|SOS|COLISION|CHOQUE/.test(k)) return 'critica';
    if (/PARADA|STOP|IDLE|RALENTI/.test(k)) return 'media';
    return 'alta';
  },

  /** Trae las alertas configuradas de Samsara y asegura las etiquetas de cámara conocidas. */
  sincronizar: function () {
    const configs = SamsaraClient.listarConfiguracionesAlertas();
    const repo = DB.table('alertas_samsara');
    const todas = repo.all();
    const actuales = {};
    todas.filter((a) => !this.esSeguridad_(a)).forEach((a) => { actuales[String(a.configuracion_id)] = a; });
    const tipos = CatalogoService.tipos(true);
    const ahora = new Date();
    const vistos = {};
    const nuevas = [];
    const cambios = {};
    const nombresNuevas = [], nombresRetiradas = [];
    // Copia de lo que entregó Samsara, para revisarlo en la pantalla (qué llegó y con qué disparador)
    const lectura = configs.map((c) => ({ id: String(c.id || ''), nombre: String(c.name || c.description || ''),
      habilitada: c.isEnabled !== false, disparador: this.disparadores_(c) }));
    configs.forEach((c) => {
      const id = String(c.id || '');
      if (!id) return;
      vistos[id] = true;
      const nombre = String(c.name || c.description || 'Alerta ' + id).trim();
      const habilitada = c.isEnabled !== false;
      const a = actuales[id];
      if (!a) {
        const destino = habilitada && !this.NO_VIGILAR.test(this.K_(nombre)) ? 'monitoreo' : 'ninguno';
        nombresNuevas.push(nombre);
        nuevas.push({
          origen: 'alerta', configuracion_id: id, nombre: nombre, destino: destino, vigilar: destino !== 'ninguno',
          severidad: this.severidadSugerida(nombre),
          tipo_id: CatalogoService.tipoSugerido({ tipo_evento: nombre }, tipos) || '',
          habilitada_samsara: habilitada, en_samsara: true, creado_en: ahora, actualizado_en: ahora,
        });
      } else if (a.nombre !== nombre || (a.habilitada_samsara !== false) !== habilitada || a.en_samsara === false || !a.origen) {
        cambios[a.id] = { origen: 'alerta', nombre: nombre, habilitada_samsara: habilitada, en_samsara: true, actualizado_en: ahora };
      }
    });
    let retiradas = 0;
    Object.keys(actuales).forEach((id) => {
      const a = actuales[id];
      if (!vistos[id] && a.en_samsara !== false && a.manual !== true) { cambios[a.id] = { en_samsara: false, actualizado_en: ahora }; retiradas++; nombresRetiradas.push(a.nombre); }
    });
    if (nuevas.length) repo.insertMany(nuevas);
    if (Object.keys(cambios).length) repo.updateMany(cambios);
    const etiquetas = this.asegurarEtiquetas(this.ETIQUETAS_SEGURIDAD.map((e) => e[0]), todas);
    Parametros.set('alertas_samsara_sync', ahora.toISOString());
    Parametros.set('alertas_samsara_lectura', JSON.stringify(lectura).slice(0, 45000));
    return { total: configs.length, nuevas: nuevas.length, retiradas: retiradas, etiquetas_nuevas: etiquetas,
      nombres_nuevas: nombresNuevas, nombres_retiradas: nombresRetiradas };
  },

  /** Saca el id de la alerta de un enlace de Samsara (de la alerta o de uno de sus incidentes) o de un id suelto. */
  idDeEnlace: function (texto) {
    texto = String(texto || '').trim();
    const uuid = texto.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuid) return uuid[0].toLowerCase();
    return /^[A-Za-z0-9_-]{4,64}$/.test(texto) ? texto : '';
  },

  /**
   * Agrega una alerta que Samsara no lista por API. Comprueba que Samsara entregue sus incidentes.
   * datos: { enlace, nombre }. Devuelve { alerta, incidentes_7d }.
   */
  agregarPorEnlace: function (datos, usuario) {
    const id = this.idDeEnlace(datos.enlace);
    if (!id) throw new Error('No encontré el id de la alerta en el enlace. Pega la dirección de la alerta o de uno de sus incidentes en Samsara.');
    const nombre = String(datos.nombre || '').trim().replace(/\s+/g, ' ');
    if (!nombre) throw new Error('Escribe el nombre de la alerta (como aparece en Samsara).');
    const repo = DB.table('alertas_samsara');
    const ya = repo.where((a) => String(a.configuracion_id) === id)[0];
    if (ya) throw new Error('Esa alerta ya está en la lista: ' + ya.nombre + '.');
    let incidentes = 0;
    try {
      const r = SamsaraClient.alertIncidentsStream({ configurationIds: [id], startTime: new Date(Date.now() - 7 * 864e5).toISOString() });
      incidentes = (r.data || []).length;
    } catch (e) {
      throw new Error('Samsara no entregó incidentes de esa alerta (' + e.message + '). Revisa el enlace.');
    }
    const ahora = new Date();
    const tipos = CatalogoService.tipos(true);
    const fila = repo.insert({
      origen: 'alerta', configuracion_id: id, nombre: nombre, destino: 'monitoreo', vigilar: true,
      severidad: this.severidadSugerida(nombre), tipo_id: CatalogoService.tipoSugerido({ tipo_evento: nombre }, tipos) || '',
      habilitada_samsara: true, en_samsara: true, manual: true, estaciones: '', creado_en: ahora, actualizado_en: ahora,
    });
    bitacora_('', '', usuario.login, 'alerta_samsara', 'Agregada por enlace: ' + nombre + ' (' + id + '), ' + incidentes + ' incidentes en 7 días.');
    return { alerta: fila, incidentes_7d: incidentes };
  },

  /** Lo que entregó Samsara en la última lectura: [{ id, nombre, habilitada, disparador }]. */
  ultimaLectura: function () {
    try { return JSON.parse(Parametros.get('alertas_samsara_lectura') || '[]'); } catch (e) { return []; }
  },

  /** Agrega las etiquetas de cámara que falten (conocidas o recién vistas en un evento). Devuelve cuántas agregó. */
  asegurarEtiquetas: function (etiquetas, filas) {
    const existentes = {};
    (filas || DB.table('alertas_samsara').all()).filter((a) => this.esSeguridad_(a))
      .forEach((a) => { existentes[String(a.configuracion_id)] = true; });
    const conocidas = {};
    this.ETIQUETAS_SEGURIDAD.forEach((e) => { conocidas[e[0]] = e; });
    const tipos = CatalogoService.tipos(true);
    const ahora = new Date();
    const nuevas = [];
    etiquetas.forEach((et) => {
      et = String(et || '').trim();
      const id = this.PREFIJO_ETIQUETA + et;
      if (!et || existentes[id]) return;
      existentes[id] = true;
      // Una etiqueta desconocida de cámara es conducta de manejo: va a Seguridad Vial.
      const c = conocidas[et] || [et, et, 'media', 'seguridad_vial'];
      nuevas.push({
        origen: 'seguridad', configuracion_id: id, nombre: c[1], destino: c[3], vigilar: c[3] !== 'ninguno', severidad: c[2],
        tipo_id: CatalogoService.tipoSugerido({ tipo_evento: c[1] + ' ' + et }, tipos) || '',
        habilitada_samsara: true, en_samsara: true, creado_en: ahora, actualizado_en: ahora,
      });
    });
    if (nuevas.length) DB.table('alertas_samsara').insertMany(nuevas);
    return nuevas.length;
  },

  /** { configuracion_id: fila } de las alertas configuradas que le llegan a alguien (existen y están habilitadas). */
  vigiladas: function () {
    const out = {};
    DB.table('alertas_samsara').where((a) => !this.esSeguridad_(a) && this.destinoDe(a) !== 'ninguno' &&
      a.en_samsara !== false && a.habilitada_samsara !== false)
      .forEach((a) => { out[String(a.configuracion_id)] = a; });
    return out;
  },

  /** { 'MobileUsage': fila } de TODAS las etiquetas de cámara. */
  reglasSeguridad: function () {
    const out = {};
    DB.table('alertas_samsara').where((a) => this.esSeguridad_(a))
      .forEach((a) => { out[String(a.configuracion_id).slice(this.PREFIJO_ETIQUETA.length)] = a; });
    return out;
  },

  /** Para la pantalla de administración. */
  listar: function () {
    const nombresTipo = {};
    CatalogoService.tipos(false).forEach((t) => { nombresTipo[t.id] = t.nombre; });
    const desde = Date.now() - 7 * 864e5;
    const conteo = {};
    DB.table('alarmas').where((x) => String(x.origen || '').indexOf('samsara') === 0 && new Date(x.recibida_en).getTime() >= desde).forEach((x) => {
      const ids = x.alertas_ids ? String(x.alertas_ids).split(';')
        : x.origen === 'samsara_alerta' ? [String(x.externo_id || '').split(':')[1] || ''] : [];
      ids.forEach((id) => { conteo[id] = (conteo[id] || 0) + (Number(x.repeticiones) || 1); });
    });
    const orden = { monitoreo: 0, ambos: 1, seguridad_vial: 2, ninguno: 3 };
    const nombresEst = {};
    DB.table('estaciones').all().forEach((e) => { nombresEst[e.id] = e.nombre; });
    return DB.table('alertas_samsara').all().map((a) => {
      const destino = this.destinoDe(a);
      const est = this.esSeguridad_(a) ? [] : this.estacionesDe(a);
      return {
        manual: a.manual === true, estaciones: est, nombres_estaciones: est.map((id) => nombresEst[id] || '(estación borrada)'),
        id: a.id, origen: this.esSeguridad_(a) ? 'seguridad' : 'alerta', configuracion_id: a.configuracion_id,
        etiqueta: this.esSeguridad_(a) ? String(a.configuracion_id).slice(this.PREFIJO_ETIQUETA.length) : '',
        nombre: a.nombre, destino: destino, vigilar: destino !== 'ninguno', severidad: a.severidad || 'alta',
        tipo_id: a.tipo_id || '', tipo: nombresTipo[a.tipo_id] || '', habilitada_samsara: a.habilitada_samsara !== false,
        en_samsara: a.en_samsara !== false, alarmas_7d: conteo[String(a.configuracion_id)] || 0,
      };
    }).sort((x, y) => orden[x.destino] - orden[y.destino] || String(x.nombre).localeCompare(String(y.nombre)));
  },

  guardar: function (datos, usuario) {
    const repo = DB.table('alertas_samsara');
    const a = repo.find(datos.id);
    if (!a) throw new Error('Alerta no encontrada.');
    const severidad = String(datos.severidad || '');
    if (this.SEVERIDADES.indexOf(severidad) === -1) throw new Error('Severidad inválida.');
    const tipoId = datos.tipo_id || '';
    if (tipoId && !DB.table('tipos_incidencia').find(tipoId)) throw new Error('Tipo de incidencia no encontrado.');
    // Compatibilidad: quien mande solo vigilar (sí/no) lo manda a Monitoreo.
    const destino = datos.destino !== undefined ? String(datos.destino) : (datos.vigilar === true ? 'monitoreo' : 'ninguno');
    if (this.DESTINOS.indexOf(destino) === -1) throw new Error('Elige a quién le llega.');
    const cambios = { destino: destino, vigilar: destino !== 'ninguno', severidad: severidad, tipo_id: tipoId, actualizado_en: new Date() };
    // Estaciones que la ven: solo alertas configuradas (los eventos de cámara van por la etiqueta de la unidad)
    let nombresEst = [];
    if (!this.esSeguridad_(a) && datos.estaciones !== undefined) {
      const lista = (Array.isArray(datos.estaciones) ? datos.estaciones : String(datos.estaciones || '').split(';'))
        .map((x) => String(x).trim()).filter(Boolean);
      const unicas = lista.filter((x, i) => lista.indexOf(x) === i);
      unicas.forEach((id) => {
        const e = DB.table('estaciones').find(id);
        if (!e) throw new Error('Estación no encontrada.');
        nombresEst.push(e.nombre);
      });
      cambios.estaciones = unicas.join(';');
    }
    // El nombre de las etiquetas de cámara se puede traducir; el de las alertas configuradas viene de Samsara.
    if ((this.esSeguridad_(a) || a.manual === true) && datos.nombre !== undefined) {
      const nombre = String(datos.nombre || '').trim().replace(/\s+/g, ' ');
      if (!nombre) throw new Error('Escribe el nombre.');
      cambios.nombre = nombre;
    }
    const r = repo.update(a.id, cambios);
    const nombreDestino = { monitoreo: 'le llega a Monitoreo', seguridad_vial: 'le llega a Seguridad Vial', ambos: 'le llega a Monitoreo y Seguridad Vial', ninguno: 'no le llega a nadie' };
    bitacora_('', '', usuario.login, 'alerta_samsara', (cambios.nombre || a.nombre) + ': ' + nombreDestino[destino] + ', severidad ' + severidad +
      (tipoId ? ', tipo sugerido ' + (DB.table('tipos_incidencia').find(tipoId) || {}).nombre : '') +
      (cambios.estaciones !== undefined ? ', la ven: ' + (nombresEst.length ? nombresEst.join(', ') : 'según la unidad') : ''));
    return r;
  },
};
