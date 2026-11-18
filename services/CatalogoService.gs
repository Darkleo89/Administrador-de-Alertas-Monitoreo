/**
 * Catálogos del negocio: circuitos, tipos de incidencia, listas de distribución y catálogos simples.
 * Regla de destinatarios (docs/plan-catalogos.md):
 *   circuito + tipo de incidencia -> la(s) lista(s) de ese circuito que contienen ese tipo -> correos
 *   Si no hay ninguna: lista de respaldo.
 */
const CatalogoService = {
  clave: function (s) {
    return String(s === null || s === undefined ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toUpperCase().replace(/\s+/g, ' ').trim();
  },
  tipoIds_: function (lista) {
    return String(lista.tipo_ids || '').split(';').map((x) => x.trim()).filter(Boolean);
  },
  correos_: function (lista) {
    return String(lista.correos || '').split(/[;,\s]+/).map((x) => x.trim()).filter(Boolean);
  },

  circuitos: function (soloActivos) {
    return DB.table('circuitos').where((c) => !soloActivos || c.activo !== false)
      .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
  },
  tipos: function (soloActivos) {
    return DB.table('tipos_incidencia').where((t) => !soloActivos || t.activo !== false)
      .sort((a, b) => Number(a.orden || 0) - Number(b.orden || 0));
  },

  /** Listas que reciben un tipo en un circuito (puede haber más de una: se avisa en la matriz). */
  listasPara: function (circuitoId, tipoId, listas) {
    listas = listas || DB.table('listas_distribucion').where((l) => l.activa !== false && !l.es_respaldo);
    return listas.filter((l) => String(l.circuito_id) === String(circuitoId) && this.tipoIds_(l).indexOf(String(tipoId)) !== -1);
  },

  /** Lista que recibe los reportes de Seguridad Vial (se crea vacía si no existe; el Admin captura los correos). */
  listaSeguridadVial: function () {
    const repo = DB.table('listas_distribucion');
    const l = repo.where((x) => x.es_seguridad_vial === true)[0];
    if (l) return l;
    return repo.insert({ nombre: 'Lista Seguridad Vial', circuito_id: '', tipo_ids: '', correos: '', activa: true,
      es_respaldo: false, es_seguridad_vial: true, actualizado_en: new Date() });
  },

  listaRespaldo: function () {
    return DB.table('listas_distribucion').where((l) => l.es_respaldo === true)[0] || null;
  },

  /** Destinatarios de un ticket: { listas: [nombres], correos: [...], respaldo: bool } */
  destinatarios: function (circuitoId, tipoId) {
    const ls = circuitoId && tipoId ? this.listasPara(circuitoId, tipoId) : [];
    if (ls.length) {
      const correos = [];
      ls.forEach((l) => this.correos_(l).forEach((c) => { if (correos.indexOf(c) === -1) correos.push(c); }));
      return { listas: ls.map((l) => l.nombre), correos: correos, respaldo: false };
    }
    const r = this.listaRespaldo();
    return { listas: r ? [r.nombre] : [], correos: r ? this.correos_(r) : [], respaldo: true };
  },

  /**
   * Matriz de cobertura: circuitos activos × tipos activos.
   * celdas[circuitoId][tipoId] = [{ id, nombre }]  (vacío = sin lista -> respaldo; 2+ = duplicado)
   */
  cobertura: function () {
    const circs = this.circuitos(true);
    const tps = this.tipos(true);
    const listas = DB.table('listas_distribucion').where((l) => l.activa !== false && !l.es_respaldo);
    const celdas = {};
    let huecos = 0, dobles = 0;
    circs.forEach((c) => {
      celdas[c.id] = {};
      tps.forEach((t) => {
        const ls = this.listasPara(c.id, t.id, listas).map((l) => ({ id: l.id, nombre: l.nombre }));
        celdas[c.id][t.id] = ls;
        if (!ls.length) huecos++;
        if (ls.length > 1) dobles++;
      });
    });
    return {
      circuitos: circs.map((c) => ({ id: c.id, nombre: c.nombre })),
      tipos: tps.map((t) => ({ id: t.id, nombre: t.nombre, clasificacion: t.clasificacion })),
      celdas: celdas, huecos: huecos, dobles: dobles,
    };
  },

  // ---------------- Formulario del ticket ----------------
  TIPOS_SIMPLES: ['cliente', 'supervisor', 'conductor', 'remolque', 'dolly', 'ruta'],

  /** Clave para comparar nombres; en números económicos ignora ceros a la izquierda (AD-004 = AD-04). */
  claveCatalogo_: function (tipo, s) {
    const k = this.clave(s);
    return ['remolque', 'dolly'].indexOf(tipo) !== -1 ? k.replace(/\d+/g, (n) => String(Number(n))) : k;
  },

  /** Todo lo que necesita el formulario del ticket (se carga una vez al abrirlo). */
  datosTicket: function () {
    const listas = DB.table('listas_distribucion').where((l) => l.activa !== false);
    const porCircuito = {};
    listas.filter((l) => !l.es_respaldo).forEach((l) => {
      (porCircuito[l.circuito_id] = porCircuito[l.circuito_id] || []).push({ nombre: l.nombre, tipo_ids: this.tipoIds_(l), n: this.correos_(l).length });
    });
    const resp = listas.find((l) => l.es_respaldo);
    const cat = {};
    this.TIPOS_SIMPLES.forEach((t) => { cat[t] = []; });
    DB.table('catalogos').where((c) => c.estatus !== 'Inactivo' && cat[c.tipo]).forEach((c) => {
      cat[c.tipo].push(c.tipo === 'supervisor' ? { n: c.nombre, c: c.circuito_id || '' } : c.nombre);
    });
    Object.keys(cat).forEach((t) => cat[t].sort((a, b) => String(a.n || a).localeCompare(String(b.n || b))));
    return {
      tipos: this.tipos(true).map((t) => ({ id: t.id, nombre: t.nombre, clasificacion: t.clasificacion, severidad: t.severidad, inmediato: t.escalamiento_inmediato === true })),
      circuitos: this.circuitos(true).map((c) => ({ id: c.id, nombre: c.nombre })),
      listas: porCircuito, respaldo: resp ? { nombre: resp.nombre, n: this.correos_(resp).length } : null,
      catalogos: cat,
    };
  },

  /** Tipo de incidencia sugerido para una alarma (por su tipo de evento de Samsara). */
  tipoSugerido: function (alarma, tipos) {
    const texto = this.clave((alarma.tipo_evento || '') + ' ' + (alarma.categoria || ''));
    const regla = CONFIG.TIPO_SUGERIDO.find((r) => r.re.test(texto));
    if (!regla) return '';
    const t = (tipos || this.tipos(true)).find((x) => this.clave(x.nombre) === this.clave(regla.tipo));
    return t ? t.id : '';
  },

  /** Si el valor no existe en su catálogo, lo agrega como "Por validar". Devuelve true si lo agregó. */
  registrarSiNuevo: function (tipo, nombre, circuitoId, login, existentes) {
    const valor = String(nombre || '').trim().replace(/\s+/g, ' ').toUpperCase();
    if (!valor || this.TIPOS_SIMPLES.indexOf(tipo) === -1) return false;
    const k = this.claveCatalogo_(tipo, valor);
    const lista = existentes || DB.table('catalogos').where((c) => c.tipo === tipo);
    if (lista.some((c) => c.tipo === tipo && this.claveCatalogo_(tipo, c.nombre) === k)) return false;
    const fila = DB.table('catalogos').insert({
      tipo: tipo, nombre: valor, circuito_id: tipo === 'supervisor' ? (circuitoId || '') : '', estatus: 'Por validar',
      origen: 'captura', externo_id: '', creado_por: login, creado_en: new Date(), actualizado_en: new Date(),
    });
    lista.push(fila);
    return true;
  },

  /** Texto de la cobertura para el registro de ejecución (huecos por circuito). */
  resumenHuecos: function () {
    const m = this.cobertura();
    const nombreTipo = {};
    m.tipos.forEach((t) => { nombreTipo[t.id] = t.nombre; });
    return m.circuitos.map((c) => {
      const faltan = Object.keys(m.celdas[c.id]).filter((t) => !m.celdas[c.id][t].length).map((t) => nombreTipo[t]);
      return c.nombre + ': ' + (faltan.length ? faltan.length + ' sin lista (' + faltan.join(', ') + ')' : 'completo');
    });
  },
};
