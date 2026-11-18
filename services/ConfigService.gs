/**
 * Parámetros editables desde Configuración → Sistema → Parámetros.
 * Los valores por omisión viven en CONFIG (config/Config.gs); lo que cambia el Admin se guarda en la
 * tabla `parametros` con id "cfg.<clave>" y se aplica sobre CONFIG al inicio de cada petición (aplicar()).
 * En la migración a Node/Python: misma tabla, mismo mecanismo.
 */
const ConfigService = {
  /** Catálogo de parámetros editables. tipo: numero | texto | booleano | turnos | areas */
  PARAMS: [
    { clave: 'SLA.TICKET_META_MIN', grupo: 'Tiempos de atención (SLA)', etiqueta: 'Meta para enviar el ticket (min)', tipo: 'numero', min: 1, max: 120,
      ayuda: 'Tiempo máximo desde que llega la alarma hasta que el ticket se envía al área. Se usa en Desempeño y en los cronómetros.' },
    { clave: 'SLA.PRIMER_ESTATUS_MIN', grupo: 'Tiempos de atención (SLA)', etiqueta: 'Primer estatus (min)', tipo: 'numero', min: 5, max: 240,
      ayuda: 'Plazo para registrar el primer seguimiento con el operador o el área (Caso de Negocio: 30–40 min).' },
    { clave: 'SLA.ESCALAMIENTO_ALTO_RIESGO_MIN', grupo: 'Tiempos de atención (SLA)', etiqueta: 'Escalamiento en zona de alto riesgo (min)', tipo: 'numero', min: 5, max: 480,
      ayuda: 'Si el ticket no se atiende en este tiempo, se escala automáticamente al Jefe de Monitoreo.' },
    { clave: 'SLA.ESCALAMIENTO_ZONA_SEGURA_MIN', grupo: 'Tiempos de atención (SLA)', etiqueta: 'Escalamiento en zona segura (min)', tipo: 'numero', min: 5, max: 960,
      ayuda: 'Igual que el anterior, para zonas seguras.' },
    { clave: 'AREA_ESCALAMIENTO', grupo: 'Tiempos de atención (SLA)', etiqueta: 'Área que recibe los escalamientos', tipo: 'area', ayuda: 'Además de las áreas del ticket.' },

    { clave: 'TURNOS.inicios', grupo: 'Turnos', etiqueta: 'Hora de inicio de los 3 turnos', tipo: 'turnos',
      ayuda: 'Matutino, vespertino y nocturno, separados por coma (ej. 6,14,22). Cada turno termina cuando empieza el siguiente.' },
    { clave: 'TURNO_TOLERANCIA_RETARDO_MIN', grupo: 'Turnos', etiqueta: 'Tolerancia de retardo (min)', tipo: 'numero', min: 0, max: 60,
      ayuda: 'Inicios de turno más tarde que esto cuentan como retardo en Desempeño.' },
    { clave: 'TURNO_CIERRE_AUTOMATICO_H', grupo: 'Turnos', etiqueta: 'Cierre automático de turno olvidado (h)', tipo: 'numero', min: 8, max: 24,
      ayuda: 'Un turno que nadie entregó se cierra solo después de estas horas y sus alarmas regresan a la cola.' },

    { clave: 'AUTH.SESION_INACTIVIDAD_MIN', grupo: 'Acceso', etiqueta: 'Cerrar sesión por inactividad (min)', tipo: 'numero', min: 10, max: 600, ayuda: '' },
    { clave: 'AUTH.MAX_INTENTOS', grupo: 'Acceso', etiqueta: 'Intentos fallidos antes de bloquear', tipo: 'numero', min: 3, max: 20, ayuda: '' },
    { clave: 'AUTH.BLOQUEO_MIN', grupo: 'Acceso', etiqueta: 'Minutos de bloqueo', tipo: 'numero', min: 1, max: 1440, ayuda: '' },

    { clave: 'EVIDENCIAS.MAX_FOTOS', grupo: 'Evidencias', etiqueta: 'Fotos máximas por incidencia', tipo: 'numero', min: 1, max: 30,
      ayuda: 'La Plantilla de Reporte contempla 15.' },

    { clave: 'SAMSARA.TAG_PADRE_ESTACIONES', grupo: 'Samsara', etiqueta: 'Etiqueta padre de las estaciones', tipo: 'texto',
      ayuda: 'Las etiquetas hijas de esta etiqueta en Samsara son las estaciones.' },
    { clave: 'SAMSARA.ETIQUETAS_REMOLQUE_INACTIVO', grupo: 'Samsara', etiqueta: 'Etiquetas de remolques dados de baja', tipo: 'texto',
      ayuda: 'Separadas por coma. Los remolques con estas etiquetas en Samsara no se ofrecen en el ticket (p. ej. Bajas, Perdida Total).' },
    { clave: 'SAMSARA.TAG_PADRE_CIRCUITOS', grupo: 'Samsara', etiqueta: 'Etiqueta padre de los circuitos', tipo: 'texto',
      ayuda: 'Las etiquetas dentro de esta (p. ej. GRUPO GAL) definen el circuito de cada unidad, según la tabla de equivalencias.' },
    { clave: 'SAMSARA.SYNC_ESTACIONES_MIN', grupo: 'Samsara', etiqueta: 'Sincronizar estaciones cada (min)', tipo: 'numero', min: 15, max: 1440, ayuda: '' },
    { clave: 'SAMSARA.SOLO_UNIDADES_MONITOREO', grupo: 'Samsara', etiqueta: 'Solo alarmas de unidades con estación', tipo: 'booleano',
      ayuda: 'Si está activo, se ignoran las alarmas de vehículos sin etiqueta de estación.' },

    { clave: 'EMPRESA', grupo: 'General', etiqueta: 'Nombre de la empresa (correo y PDF)', tipo: 'texto', ayuda: '' },
  ],

  aplicado_: false,
  base_: null,

  getPath_: function (clave) {
    if (clave === 'TURNOS.inicios') return CONFIG.TURNOS.map((t) => t.inicio).join(',');
    if (clave.indexOf('CATEGORIAS|') === 0) return CONFIG.CATEGORIAS[clave.split('|')[1]].areas.slice();
    return clave.split('.').reduce((o, k) => (o ? o[k] : undefined), CONFIG);
  },
  setPath_: function (clave, valor) {
    if (clave === 'TURNOS.inicios') {
      const h = String(valor).split(',').map(Number);
      CONFIG.TURNOS.forEach((t, i) => { t.inicio = h[i]; t.fin = h[(i + 1) % 3]; });
      return;
    }
    if (clave.indexOf('CATEGORIAS|') === 0) { CONFIG.CATEGORIAS[clave.split('|')[1]].areas = valor; return; }
    const ks = clave.split('.');
    const obj = ks.slice(0, -1).reduce((o, k) => o[k], CONFIG);
    obj[ks[ks.length - 1]] = valor;
  },
  /** Todas las claves editables, incluida la lista de áreas de cada categoría. */
  claves_: function () {
    return this.PARAMS.map((p) => p.clave).concat(Object.keys(CONFIG.CATEGORIAS).map((c) => 'CATEGORIAS|' + c));
  },

  /** Aplica los valores guardados sobre CONFIG (una vez por ejecución). */
  aplicar: function () {
    if (this.aplicado_) return;
    this.aplicado_ = true;
    if (!this.base_) {
      this.base_ = {};
      this.claves_().forEach((k) => { this.base_[k] = JSON.stringify(this.getPath_(k)); });
    }
    DB.table('parametros').where((p) => String(p.id).indexOf('cfg.') === 0 && p.valor !== null && p.valor !== '').forEach((p) => {
      const clave = String(p.id).slice(4);
      if (!this.base_.hasOwnProperty(clave)) return;
      try { this.setPath_(clave, JSON.parse(p.valor)); } catch (e) { console.warn('Parámetro inválido ' + p.id); }
    });
  },

  listar: function () {
    this.aplicar();
    const guardados = {};
    DB.table('parametros').where((p) => String(p.id).indexOf('cfg.') === 0).forEach((p) => { guardados[String(p.id).slice(4)] = p; });
    const params = this.PARAMS.map((p) => Object.assign({}, p, {
      valor: this.getPath_(p.clave), defecto: JSON.parse(this.base_[p.clave]),
      modificado: !!(guardados[p.clave] && guardados[p.clave].valor), actualizado_en: guardados[p.clave] ? guardados[p.clave].actualizado_en : null,
    }));
    const categorias = Object.keys(CONFIG.CATEGORIAS).map((c) => ({
      categoria: c, severidad: CONFIG.CATEGORIAS[c].severidad, areas: CONFIG.CATEGORIAS[c].areas,
      defecto: JSON.parse(this.base_['CATEGORIAS|' + c]), modificado: !!(guardados['CATEGORIAS|' + c] && guardados['CATEGORIAS|' + c].valor),
    }));
    return { params: params, categorias: categorias, areas: DB.table('areas').where((a) => a.activa !== false).map((a) => a.nombre) };
  },

  validar_: function (clave, valor) {
    if (clave.indexOf('CATEGORIAS|') === 0) {
      const cat = CONFIG.CATEGORIAS[clave.split('|')[1]];
      if (!cat) throw new Error('Categoría desconocida.');
      if (!Array.isArray(valor) || !valor.length) throw new Error('Cada categoría debe notificar al menos a un área.');
      // Las áreas que se AGREGAN deben existir y estar activas; las que ya tenía la categoría se respetan.
      const activas = DB.table('areas').where((a) => a.activa !== false).map((a) => a.nombre);
      valor.forEach((a) => { if (activas.indexOf(a) === -1 && cat.areas.indexOf(a) === -1) throw new Error('Área desconocida o dada de baja: ' + a); });
      return valor.filter((a, i) => valor.indexOf(a) === i);
    }
    const p = this.PARAMS.find((x) => x.clave === clave);
    if (!p) throw new Error('Parámetro no editable: ' + clave);
    if (p.tipo === 'numero') {
      const n = Number(valor);
      if (!isFinite(n) || Math.round(n) !== n) throw new Error(p.etiqueta + ': debe ser un número entero.');
      if (n < p.min || n > p.max) throw new Error(p.etiqueta + ': debe estar entre ' + p.min + ' y ' + p.max + '.');
      return n;
    }
    if (p.tipo === 'booleano') return valor === true || valor === 'true';
    if (p.tipo === 'turnos') {
      const h = String(valor).split(',').map((x) => Number(String(x).trim()));
      if (h.length !== 3 || h.some((x) => !isFinite(x) || Math.round(x) !== x || x < 0 || x > 23)) throw new Error('Escribe 3 horas entre 0 y 23, separadas por coma.');
      const dur = [(h[1] - h[0] + 24) % 24, (h[2] - h[1] + 24) % 24, (h[0] - h[2] + 24) % 24];
      if (dur.some((d) => d === 0) || dur.reduce((s, d) => s + d, 0) !== 24) throw new Error('Los turnos deben ir en orden y cubrir las 24 horas.');
      return h.join(',');
    }
    if (p.tipo === 'area') {
      if (DB.table('areas').where((a) => a.nombre === valor && a.activa !== false).length === 0) throw new Error('Área inválida.');
      return String(valor);
    }
    const t = String(valor || '').trim();
    if (!t || t.length > 100) throw new Error(p.etiqueta + ': escribe un texto de 1 a 100 caracteres.');
    return t;
  },

  guardar: function (clave, valor, usuario) {
    this.aplicar();
    const limpio = this.validar_(clave, valor);
    Parametros.set('cfg.' + clave, JSON.stringify(limpio));
    this.setPath_(clave, limpio);
    bitacora_('', '', usuario.login, 'parametro', clave + ' = ' + JSON.stringify(limpio));
    return true;
  },

  restablecer: function (clave, usuario) {
    this.aplicar();
    if (!this.base_.hasOwnProperty(clave)) throw new Error('Parámetro no editable.');
    Parametros.set('cfg.' + clave, '');
    this.setPath_(clave, JSON.parse(this.base_[clave]));
    bitacora_('', '', usuario.login, 'parametro', clave + ' restablecido al valor por omisión');
    return true;
  },
};
