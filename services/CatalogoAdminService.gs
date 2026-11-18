/**
 * Administración de catálogos (paso 4 de docs/plan-catalogos.md):
 *  - Catálogos simples (clientes, supervisores, conductores, remolques, dollys, rutas): alta, edición,
 *    baja, validación de "Por validar" y UNIR (corrige el nombre en los tickets que lo usaron).
 *  - Tipos de incidencia, circuitos, listas de distribución (+ matriz de cobertura) y etiquetas de Samsara.
 * Todo queda en la bitácora. Portable: solo usa DB, CatalogoService y CONFIG.
 */
const CatalogoAdminService = {
  EMAIL_RE: /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/,
  /** Campos del ticket donde aparece cada catálogo (para Unir). */
  CAMPOS_TICKET: {
    cliente: ['cliente', 'operacion'], supervisor: ['supervisor'], conductor: ['operador'],
    remolque: ['remolque1', 'remolque2'], dolly: ['dolly'], ruta: ['ruta'],
  },
  ESTATUS: ['Activo', 'Inactivo', 'Por validar'],
  SEVERIDADES: ['critica', 'alta', 'media', 'baja'],
  USOS_ETIQUETA: ['circuito', 'dolly', 'remolque', 'empresa', 'ignorar', 'sin_asignar'],

  log_: function (usuario, accion, nota) { bitacora_('', '', usuario.login, accion, nota); },
  limpio_: function (s) { return String(s === null || s === undefined ? '' : s).trim().replace(/\s+/g, ' '); },
  K_: function (s) { return CatalogoService.clave(s); },

  // ================= Catálogos simples =================
  resumen: function () {
    const r = {};
    CatalogoService.TIPOS_SIMPLES.forEach((t) => { r[t] = { total: 0, activos: 0, por_validar: 0, inactivos: 0 }; });
    DB.table('catalogos').all().forEach((c) => {
      const x = r[c.tipo]; if (!x) return;
      x.total++;
      if (c.estatus === 'Por validar') x.por_validar++; else if (c.estatus === 'Inactivo') x.inactivos++; else x.activos++;
    });
    return r;
  },

  listarSimple: function (tipo) {
    if (CatalogoService.TIPOS_SIMPLES.indexOf(tipo) === -1) throw new Error('Catálogo inválido.');
    return DB.table('catalogos').where((c) => c.tipo === tipo).map((c) => ({
      id: c.id, nombre: c.nombre, circuito_id: c.circuito_id || '', estatus: c.estatus || 'Activo', origen: c.origen || '',
      creado_por: c.creado_por || '', creado_en: c.creado_en || '', samsara: !!c.externo_id,
    })).sort((a, b) => (a.estatus === 'Por validar' ? -1 : 0) - (b.estatus === 'Por validar' ? -1 : 0) || String(a.nombre).localeCompare(String(b.nombre)));
  },

  /** datos = { id?, tipo, nombre, circuito_id?, estatus } */
  guardarSimple: function (datos, usuario) {
    const tipo = datos.tipo;
    if (CatalogoService.TIPOS_SIMPLES.indexOf(tipo) === -1) throw new Error('Catálogo inválido.');
    const nombre = this.limpio_(datos.nombre).toUpperCase();
    if (!nombre || nombre.length > 120) throw new Error('Escribe el nombre (máx. 120 caracteres).');
    const estatus = this.ESTATUS.indexOf(datos.estatus) !== -1 ? datos.estatus : 'Activo';
    const circuitoId = tipo === 'supervisor' ? (datos.circuito_id || '') : '';
    if (tipo === 'supervisor' && !circuitoId) throw new Error('El supervisor necesita su circuito.');
    const k = CatalogoService.claveCatalogo_(tipo, nombre);
    const repo = DB.table('catalogos');
    const dup = repo.where((c) => c.tipo === tipo && c.id !== datos.id && CatalogoService.claveCatalogo_(tipo, c.nombre) === k &&
      (tipo !== 'supervisor' || String(c.circuito_id || '') === String(circuitoId)));
    if (dup.length) throw new Error('Ya existe "' + dup[0].nombre + '" en este catálogo. Usa "Unir" si es el mismo.');
    const ahora = new Date();
    if (datos.id) {
      const actual = repo.find(datos.id);
      if (!actual || actual.tipo !== tipo) throw new Error('Registro no encontrado.');
      const r = repo.update(datos.id, { nombre: nombre, circuito_id: circuitoId, estatus: estatus, actualizado_en: ahora });
      const cambios = [];
      if (actual.nombre !== nombre) cambios.push(actual.nombre + ' → ' + nombre);
      if ((actual.estatus || 'Activo') !== estatus) cambios.push(estatus);
      if (String(actual.circuito_id || '') !== String(circuitoId)) cambios.push('circuito');
      this.log_(usuario, 'catalogo', tipo + ': ' + nombre + (cambios.length ? ' (' + cambios.join(', ') + ')' : ''));
      return r;
    }
    const r = repo.insert({ tipo: tipo, nombre: nombre, circuito_id: circuitoId, estatus: estatus, origen: 'admin', externo_id: '',
      creado_por: usuario.login, creado_en: ahora, actualizado_en: ahora });
    this.log_(usuario, 'catalogo', 'Alta de ' + tipo + ': ' + nombre);
    return r;
  },

  /**
   * Une el registro `origenId` con `destinoId` (mismo catálogo): los tickets que usaban el nombre de origen
   * pasan a usar el de destino, y el origen queda Inactivo. Sirve para validar "Por validar" y quitar duplicados.
   */
  unir: function (origenId, destinoId, usuario) {
    const repo = DB.table('catalogos');
    const o = repo.find(origenId), d = repo.find(destinoId);
    if (!o || !d) throw new Error('Registro no encontrado.');
    if (o.id === d.id) throw new Error('Elige un registro distinto.');
    if (o.tipo !== d.tipo) throw new Error('Solo se pueden unir registros del mismo catálogo.');
    if (d.estatus === 'Inactivo') throw new Error('El registro destino está inactivo.');
    const campos = this.CAMPOS_TICKET[o.tipo] || [];
    const ko = CatalogoService.claveCatalogo_(o.tipo, o.nombre);
    const patches = {};
    DB.table('tickets').all().forEach((t) => {
      campos.forEach((c) => {
        if (t[c] && CatalogoService.claveCatalogo_(o.tipo, t[c]) === ko) { patches[t.id] = patches[t.id] || {}; patches[t.id][c] = d.nombre; }
      });
    });
    const n = DB.table('tickets').updateMany(patches);
    repo.update(o.id, { estatus: 'Inactivo', origen: 'unido', actualizado_en: new Date() });
    if (d.estatus === 'Por validar') repo.update(d.id, { estatus: 'Activo', actualizado_en: new Date() });
    this.log_(usuario, 'catalogo', o.tipo + ': "' + o.nombre + '" unido con "' + d.nombre + '" (' + n + ' ticket(s) actualizados)');
    return { tickets_actualizados: n };
  },

  // ================= Tipos de incidencia =================
  listarTipos: function () {
    return CatalogoService.tipos(false).map((t) => ({
      id: t.id, nombre: t.nombre, clasificacion: t.clasificacion || 'Incidencia', severidad: t.severidad || 'media',
      sla_primer_estatus_min: t.sla_primer_estatus_min || '', sla_escalamiento_min: t.sla_escalamiento_min || '',
      escalamiento_inmediato: t.escalamiento_inmediato === true, activo: t.activo !== false, orden: t.orden || '',
    }));
  },
  numeroOpc_: function (v, etiqueta, max) {
    if (v === '' || v === null || v === undefined) return '';
    const n = Number(v);
    if (!isFinite(n) || Math.round(n) !== n || n < 1 || n > max) throw new Error(etiqueta + ': número entero entre 1 y ' + max + ' (o vacío para usar el valor general).');
    return n;
  },
  guardarTipo: function (datos, usuario) {
    const nombre = this.limpio_(datos.nombre).toUpperCase();
    if (!nombre || nombre.length > 80) throw new Error('Escribe el nombre del tipo (máx. 80 caracteres).');
    if (['Incidencia', 'Ocurrencia'].indexOf(datos.clasificacion) === -1) throw new Error('Clasificación: Incidencia u Ocurrencia.');
    if (this.SEVERIDADES.indexOf(datos.severidad) === -1) throw new Error('Severidad inválida.');
    const repo = DB.table('tipos_incidencia');
    const todos = repo.all();
    if (todos.some((t) => t.id !== datos.id && this.K_(t.nombre) === this.K_(nombre))) throw new Error('Ya existe ese tipo de incidencia.');
    const campos = {
      nombre: nombre, clasificacion: datos.clasificacion, severidad: datos.severidad,
      sla_primer_estatus_min: this.numeroOpc_(datos.sla_primer_estatus_min, 'Primer estatus', 1440),
      sla_escalamiento_min: this.numeroOpc_(datos.sla_escalamiento_min, 'Escalamiento', 2880),
      escalamiento_inmediato: datos.escalamiento_inmediato === true, activo: datos.activo !== false, actualizado_en: new Date(),
    };
    if (datos.id) {
      const actual = repo.find(datos.id);
      if (!actual) throw new Error('Tipo no encontrado.');
      const r = repo.update(datos.id, campos);
      this.log_(usuario, 'tipo_incidencia', 'Cambio: ' + nombre + ' (' + campos.clasificacion + ', ' + campos.severidad + (campos.escalamiento_inmediato ? ', inmediato' : '') + (campos.activo ? '' : ', INACTIVO') + ')');
      return r;
    }
    campos.orden = todos.reduce((m, t) => Math.max(m, Number(t.orden || 0)), 0) + 1;
    const r = repo.insert(campos);
    this.log_(usuario, 'tipo_incidencia', 'Alta: ' + nombre + ' (' + campos.clasificacion + '). Asígnalo a las listas en la matriz de cobertura.');
    return r;
  },

  // ================= Circuitos =================
  listarCircuitos: function () {
    const nUni = {}, nLis = {};
    DB.table('unidades').where((u) => u.activo !== false).forEach((u) => {
      String(u.circuitos_ids || u.circuito_id || '').split(';').filter(Boolean).forEach((c) => { nUni[c] = (nUni[c] || 0) + 1; });
    });
    DB.table('listas_distribucion').where((l) => l.activa !== false && !l.es_respaldo).forEach((l) => { nLis[l.circuito_id] = (nLis[l.circuito_id] || 0) + 1; });
    return CatalogoService.circuitos(false).map((c) => ({ id: c.id, nombre: c.nombre, activo: c.activo !== false, unidades: nUni[c.id] || 0, listas: nLis[c.id] || 0 }));
  },
  guardarCircuito: function (datos, usuario) {
    const nombre = this.limpio_(datos.nombre).toUpperCase();
    if (!nombre || nombre.length > 60) throw new Error('Escribe el nombre del circuito.');
    const repo = DB.table('circuitos');
    if (repo.all().some((c) => c.id !== datos.id && this.K_(c.nombre) === this.K_(nombre))) throw new Error('Ya existe ese circuito.');
    const campos = { nombre: nombre, activo: datos.activo !== false };
    const r = datos.id ? repo.update(datos.id, campos) : repo.insert(campos);
    this.log_(usuario, 'circuito', (datos.id ? 'Cambio: ' : 'Alta: ') + nombre + (campos.activo ? '' : ' (inactivo)'));
    return r;
  },

  // ================= Listas de distribución =================
  correos_: function (texto) {
    const lista = String(texto || '').split(/[,;:\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
    lista.forEach((e) => { if (!this.EMAIL_RE.test(e)) throw new Error('Correo inválido: ' + e); });
    return lista.filter((e, i) => lista.indexOf(e) === i);
  },
  listarListas: function () {
    CatalogoService.listaSeguridadVial();   // siempre visible para capturar sus correos
    const tipos = {};
    CatalogoService.tipos(false).forEach((t) => { tipos[t.id] = t.nombre; });
    const circs = {};
    CatalogoService.circuitos(false).forEach((c) => { circs[c.id] = c.nombre; });
    return DB.table('listas_distribucion').all().map((l) => {
      const ids = CatalogoService.tipoIds_(l);
      return {
        id: l.id, nombre: l.nombre, circuito_id: l.circuito_id || '', circuito: circs[l.circuito_id] || '', es_respaldo: l.es_respaldo === true,
        es_seguridad_vial: l.es_seguridad_vial === true,
        activa: l.activa !== false, tipo_ids: ids, tipos: ids.map((i) => tipos[i]).filter(Boolean), correos: CatalogoService.correos_(l),
      };
    }).sort((a, b) => (b.es_respaldo ? 1 : 0) - (a.es_respaldo ? 1 : 0) || (b.es_seguridad_vial ? 1 : 0) - (a.es_seguridad_vial ? 1 : 0) || String(a.circuito).localeCompare(String(b.circuito)) || String(a.nombre).localeCompare(String(b.nombre)));
  },
  /** datos = { id?, nombre, circuito_id, tipo_ids[], correos (texto), activa } */
  guardarLista: function (datos, usuario) {
    const repo = DB.table('listas_distribucion');
    const actual = datos.id ? repo.find(datos.id) : null;
    if (datos.id && !actual) throw new Error('Lista no encontrada.');
    const esRespaldo = !!(actual && actual.es_respaldo === true);
    const esSV = !!(actual && actual.es_seguridad_vial === true);
    const nombre = this.limpio_(datos.nombre);
    if (!nombre || nombre.length > 80) throw new Error('Escribe el nombre de la lista.');
    if (repo.all().some((l) => l.id !== datos.id && this.K_(l.nombre) === this.K_(nombre))) throw new Error('Ya existe una lista con ese nombre.');
    const correos = this.correos_(datos.correos);
    if (!correos.length) throw new Error('La lista necesita al menos un correo.');
    let circuitoId = '', tipoIds = [];
    if (!esRespaldo && !esSV) {
      circuitoId = datos.circuito_id || '';
      if (!circuitoId || !DB.table('circuitos').find(circuitoId)) throw new Error('Elige el circuito de la lista.');
      const validos = {};
      DB.table('tipos_incidencia').all().forEach((t) => { validos[t.id] = true; });
      tipoIds = (datos.tipo_ids || []).filter((t) => validos[t]);
      tipoIds = tipoIds.filter((t, i) => tipoIds.indexOf(t) === i);
    }
    const campos = { nombre: nombre, circuito_id: circuitoId, tipo_ids: tipoIds.join(';'), correos: correos.join(', '),
      activa: esRespaldo || esSV ? true : datos.activa !== false, es_respaldo: esRespaldo, es_seguridad_vial: esSV, actualizado_en: new Date() };
    const r = datos.id ? repo.update(datos.id, campos) : repo.insert(campos);
    this.log_(usuario, 'lista', (datos.id ? 'Cambio: ' : 'Alta: ') + nombre + ' · ' + tipoIds.length + ' tipo(s) · ' + correos.length + ' correo(s)' + (campos.activa ? '' : ' · INACTIVA'));
    return { lista: r, avisos: this.avisosDuplicados_(r) };
  },
  /** Tipos de la lista que otra lista activa del mismo circuito también tiene (se enviaría a ambas). */
  avisosDuplicados_: function (lista) {
    if (lista.es_respaldo || lista.es_seguridad_vial || lista.activa === false) return [];
    const mios = CatalogoService.tipoIds_(lista);
    const tipos = {};
    DB.table('tipos_incidencia').all().forEach((t) => { tipos[t.id] = t.nombre; });
    const avisos = [];
    DB.table('listas_distribucion').where((l) => l.id !== lista.id && l.activa !== false && !l.es_respaldo && String(l.circuito_id) === String(lista.circuito_id))
      .forEach((l) => CatalogoService.tipoIds_(l).filter((t) => mios.indexOf(t) !== -1).forEach((t) => avisos.push(tipos[t] + ' también está en "' + l.nombre + '"')));
    return avisos;
  },
  /**
   * Desde la matriz: en ese circuito, el tipo pasa a la lista `listaId` (y se quita de las demás listas
   * del circuito). listaId vacío = quitarlo de todas (irá a la lista de respaldo).
   */
  asignarCobertura: function (circuitoId, tipoId, listaId, usuario) {
    const repo = DB.table('listas_distribucion');
    const listas = repo.where((l) => !l.es_respaldo && String(l.circuito_id) === String(circuitoId));
    if (listaId && !listas.some((l) => l.id === listaId)) throw new Error('La lista no pertenece a ese circuito.');
    const tipo = DB.table('tipos_incidencia').find(tipoId);
    if (!tipo) throw new Error('Tipo no encontrado.');
    const patches = {};
    listas.forEach((l) => {
      const ids = CatalogoService.tipoIds_(l);
      const tiene = ids.indexOf(String(tipoId)) !== -1;
      if (l.id === listaId && !tiene) patches[l.id] = { tipo_ids: ids.concat([tipoId]).join(';'), actualizado_en: new Date() };
      if (l.id !== listaId && tiene) patches[l.id] = { tipo_ids: ids.filter((x) => x !== String(tipoId)).join(';'), actualizado_en: new Date() };
    });
    repo.updateMany(patches);
    const destino = listas.find((l) => l.id === listaId);
    const circ = DB.table('circuitos').find(circuitoId);
    this.log_(usuario, 'lista', 'Cobertura ' + (circ ? circ.nombre : '') + ' · ' + tipo.nombre + ' → ' + (destino ? destino.nombre : 'lista de respaldo'));
    return true;
  },

  // ================= Etiquetas de Samsara =================
  listarEtiquetas: function () {
    const circs = {};
    CatalogoService.circuitos(false).forEach((c) => { circs[c.id] = c.nombre; });
    return DB.table('etiquetas_samsara').all().map((e) => ({
      id: e.id, etiqueta: e.etiqueta, uso: e.uso, circuito_id: e.circuito_id || '', circuito: circs[e.circuito_id] || '',
      activo: e.activo !== false, en_samsara: !!e.samsara_tag_id,
    })).sort((a, b) => (a.uso === 'sin_asignar' ? -1 : 0) - (b.uso === 'sin_asignar' ? -1 : 0) || String(a.etiqueta).localeCompare(String(b.etiqueta)));
  },
  guardarEtiqueta: function (datos, usuario) {
    const repo = DB.table('etiquetas_samsara');
    const e = repo.find(datos.id);
    if (!e) throw new Error('Etiqueta no encontrada.');
    if (this.USOS_ETIQUETA.indexOf(datos.uso) === -1) throw new Error('Uso inválido.');
    const circuitoId = datos.uso === 'circuito' ? (datos.circuito_id || '') : '';
    if (datos.uso === 'circuito' && !DB.table('circuitos').find(circuitoId)) throw new Error('Elige el circuito.');
    const r = repo.update(e.id, { uso: datos.uso, circuito_id: circuitoId, activo: datos.activo !== false });
    this.log_(usuario, 'etiqueta', e.etiqueta + ' → ' + datos.uso + (circuitoId ? ' (' + (DB.table('circuitos').find(circuitoId) || {}).nombre + ')' : '') + '. Se aplica en la próxima sincronización.');
    return r;
  },
};
