/**
 * Sincroniza catálogos con Samsara (paso 2 de docs/plan-catalogos.md):
 *  - Circuito de cada unidad: etiquetas bajo "GRUPO GAL" traducidas con la tabla etiquetas_samsara.
 *    Las subetiquetas heredan el uso de su madre. Etiquetas nuevas se registran como "sin_asignar".
 *  - Conductores activos (GET /fleet/drivers).
 *  - Remolques y dollys: GET /fleet/trailers + los ACTIVOS de las etiquetas "Remolques…" y "Dolly…"
 *    (en Samsara los dollys son activos, no trailers). Los que traen "Bajas"/"Perdida Total" quedan Inactivos.
 *  - Remolques, dollys y mamparas NO son unidades: se retiran de la tabla de unidades.
 * Lo capturado a mano o importado del Excel se respeta: solo se agrega o se vincula con Samsara.
 */
const SincronizacionCatalogos = {
  K: function (s) { return CatalogoService.clave(s); },
  /** Clave de número económico: ignora ceros a la izquierda (AD-004 = AD-04 = AD-4). */
  KE: function (s) { return this.K(s).replace(/\d+/g, (n) => String(Number(n))); },

  /** Ejecuta todo y devuelve un resumen. */
  ejecutar: function (tags) {
    tags = tags || SamsaraClient.listarTags();
    const r = { circuitos: null, conductores: null, remolques: null, errores: [] };
    let trailers = [];
    try { trailers = SamsaraClient.listarRemolques(); }
    catch (e) { r.errores.push('Remolques: ' + e.message); }
    r.circuitos = this.circuitos(tags, trailers);
    try { r.conductores = this.conductores(SamsaraClient.listarConductoresActivos()); }
    catch (e) { r.errores.push('Conductores: ' + e.message); }
    r.remolques = this.remolques(trailers, tags);
    Parametros.set('catalogos_ultima_sync', new Date().toISOString());
    return r;
  },

  // ---------------- Etiquetas: árbol de GRUPO GAL y uso efectivo ----------------
  /** { porId: {tagId: {tag, uso, circuito_id, etiqueta}}, nuevas: [nombres] } */
  arbol_: function (tags) {
    const objetivo = this.K(CONFIG.SAMSARA.TAG_PADRE_CIRCUITOS);
    const raiz = tags.find((t) => this.K(t.name) === objetivo && !t.parentTagId) || tags.find((t) => this.K(t.name) === objetivo);
    if (!raiz) throw new Error('No existe la etiqueta "' + CONFIG.SAMSARA.TAG_PADRE_CIRCUITOS + '" en Samsara.');
    const hijos = {};
    tags.forEach((t) => { const p = t.parentTagId || (t.parentTag && t.parentTag.id); if (p) (hijos[p] = hijos[p] || []).push(t); });

    const repo = DB.table('etiquetas_samsara');
    const filas = repo.all();
    const porTagId = {}, porNombre = {};
    filas.forEach((f) => { if (f.samsara_tag_id) porTagId[String(f.samsara_tag_id)] = f; if (f.activo !== false || !porNombre[this.K(f.etiqueta)]) porNombre[this.K(f.etiqueta)] = f; });

    const porId = {};
    const nuevas = [];
    const vincular = {};
    const recorrer = (tag, heredado) => {
      let fila = porTagId[String(tag.id)] || porNombre[this.K(tag.name)];
      if (!fila && tag.id !== raiz.id) {
        fila = repo.insert({ etiqueta: tag.name, samsara_tag_id: tag.id, uso: 'sin_asignar', circuito_id: '', activo: true });
        porNombre[this.K(tag.name)] = fila;
        // Solo se reporta si de verdad no tiene uso: una subetiqueta hereda el de su madre.
        if (!heredado) nuevas.push(tag.name);
      } else if (fila && String(fila.samsara_tag_id || '') !== String(tag.id)) {
        vincular[fila.id] = { samsara_tag_id: tag.id };
      }
      // Uso efectivo: el propio si define algo concreto; si no (sin_asignar / empresa), el heredado.
      let efectivo = heredado;
      if (fila && fila.activo !== false && ['circuito', 'dolly', 'remolque', 'ignorar'].indexOf(fila.uso) !== -1) {
        efectivo = { uso: fila.uso, circuito_id: fila.circuito_id || '', etiqueta: fila.etiqueta };
      }
      porId[tag.id] = { tag: tag, uso: efectivo ? efectivo.uso : '', circuito_id: efectivo ? efectivo.circuito_id : '', etiqueta: efectivo ? efectivo.etiqueta : '' };
      (hijos[tag.id] || []).forEach((h) => recorrer(h, efectivo));
    };
    recorrer(raiz, null);
    repo.updateMany(vincular);
    return { porId: porId, nuevas: nuevas, raiz: raiz };
  },

  /** Ids y nombres de lo que NO es unidad: trailers + activos de etiquetas dolly/remolque/ignorar. */
  noUnidades_: function (arbol, trailers) {
    const set = {};
    const marcar = (x) => { if (!x) return; if (x.id) set['id:' + x.id] = true; if (x.name) set[this.KE(x.name)] = true; };
    (trailers || []).forEach(marcar);
    Object.keys(arbol.porId).forEach((id) => {
      const n = arbol.porId[id];
      if (['dolly', 'remolque', 'ignorar'].indexOf(n.uso) !== -1) (n.tag.assets || []).concat(n.tag.vehicles || []).forEach(marcar);
    });
    return set;
  },

  // ---------------- 1) Circuito de cada unidad ----------------
  circuitos: function (tags, trailers) {
    const arbol = this.arbol_(tags);
    const no = this.noUnidades_(arbol, trailers);
    const esNoUnidad = (id, nombre) => !!((id && no['id:' + id]) || (nombre && no[this.KE(nombre)]));
    const asignacion = {};   // assetId -> { nombre, circuito_id (el primero), todos: [ids], etiqueta }
    const conflictos = [];
    Object.keys(arbol.porId).forEach((id) => {
      const n = arbol.porId[id];
      if (n.uso !== 'circuito' || !n.circuito_id) return;
      (n.tag.vehicles || []).concat(n.tag.assets || []).forEach((v) => {
        if (!v || !v.id || esNoUnidad(v.id, v.name)) return;
        const prev = asignacion[v.id];
        if (prev) {
          // Unidad prestada: se guardan todos sus circuitos; el ticket deja elegir entre ellos.
          if (prev.todos.indexOf(n.circuito_id) === -1) {
            prev.todos.push(n.circuito_id);
            conflictos.push((v.name || v.id) + ': "' + prev.etiqueta + '" y "' + n.tag.name + '" (se ofrecen ambos en el ticket)');
          }
          return;
        }
        asignacion[v.id] = { nombre: v.name || String(v.id), circuito_id: n.circuito_id, todos: [n.circuito_id], etiqueta: n.tag.name };
      });
    });

    const repo = DB.table('unidades');
    const unidades = repo.all();
    const porAsset = {}, porEco = {};
    unidades.forEach((u) => { if (u.samsara_asset_id) porAsset[String(u.samsara_asset_id)] = u; porEco[this.K(u.economico)] = u; });
    const patches = {};
    const nuevas = [];
    let cambios = 0;
    const ahora = new Date();
    Object.keys(asignacion).forEach((assetId) => {
      const a = asignacion[assetId];
      const u = porAsset[assetId] || porEco[this.K(a.nombre)];
      if (u) {
        if (String(u.circuito_id || '') !== String(a.circuito_id)) cambios++;
        patches[u.id] = { circuito_id: a.circuito_id, circuitos_ids: a.todos.join(';'), samsara_asset_id: assetId, sincronizado_en: ahora };
      } else {
        nuevas.push({ economico: a.nombre, samsara_asset_id: assetId, circuito_id: a.circuito_id, circuitos_ids: a.todos.join(';'), estacion_id: '', activo: true, origen: 'samsara', sincronizado_en: ahora });
      }
    });
    // Remolques, dollys y mamparas que estaban como unidades: se retiran (se conservan para el historial).
    let retirados = 0;
    unidades.forEach((u) => {
      if (u.origen !== 'remolque' && esNoUnidad(u.samsara_asset_id, u.economico)) {
        patches[u.id] = Object.assign(patches[u.id] || {}, { activo: false, origen: 'remolque', estacion_id: '', sincronizado_en: ahora });
        retirados++;
      }
    });
    repo.updateMany(patches);
    repo.insertMany(nuevas);

    const sinCircuito = repo.where((u) => u.activo !== false && !u.circuito_id).map((u) => u.economico);
    return {
      unidades_con_circuito: Object.keys(asignacion).length, unidades_cambiaron: cambios, unidades_nuevas: nuevas.length,
      retirados_de_unidades: retirados,
      unidades_sin_circuito: sinCircuito.length, ejemplos_sin_circuito: sinCircuito.slice(0, 15),
      etiquetas_nuevas_sin_asignar: arbol.nuevas, conflictos: conflictos,
    };
  },

  // ---------------- Catálogos simples con origen Samsara ----------------
  /** Une con lo existente por externo_id o por nombre; marca Inactivo lo de Samsara que ya no viene.
   *  items: [{ id, nombre, estatus? }]  (estatus por omisión: Activo) */
  fusionar_: function (tipo, items) {
    const repo = DB.table('catalogos');
    const existentes = repo.where((c) => c.tipo === tipo);
    const porExt = {}, porNombre = {};
    const clave = (s) => (tipo === 'conductor' ? this.K(s) : this.KE(s));
    existentes.forEach((c) => { if (c.externo_id) porExt[String(c.externo_id)] = c; porNombre[clave(c.nombre)] = c; });
    const ahora = new Date();
    const patches = {};
    const nuevos = [];
    const vistos = {};
    let vinculados = 0, inactivos = 0;
    items.forEach((it) => {
      const nombre = String(it.nombre || '').trim().toUpperCase().replace(/\s+/g, ' ');
      if (!nombre) return;
      const estatus = it.estatus || 'Activo';
      if (estatus !== 'Activo') inactivos++;
      const ex = porExt[String(it.id)] || porNombre[clave(nombre)];
      if (ex) {
        if (vistos[ex.id]) return;
        vistos[ex.id] = true;
        if (!ex.externo_id) vinculados++;
        // Si un admin ya lo tiene "Por validar" o corregido, se respeta el nombre; se vincula y se actualiza el estatus.
        patches[ex.id] = { externo_id: it.id, estatus: estatus, origen: ex.origen === 'samsara' ? 'samsara' : String(ex.origen || 'excel').replace('+samsara', '') + '+samsara', actualizado_en: ahora };
      } else {
        nuevos.push({ tipo: tipo, nombre: nombre, circuito_id: '', estatus: estatus, origen: 'samsara', externo_id: it.id, creado_por: 'samsara', creado_en: ahora, actualizado_en: ahora });
      }
    });
    let desactivados = 0;
    existentes.forEach((c) => {
      if (c.externo_id && !vistos[c.id] && String(c.origen || '').indexOf('samsara') !== -1 && c.estatus === 'Activo' && !patches[c.id]) {
        patches[c.id] = { estatus: 'Inactivo', actualizado_en: ahora };
        desactivados++;
      }
    });
    repo.updateMany(patches);
    repo.insertMany(nuevos);
    return { recibidos: items.length, nuevos: nuevos.length, vinculados: vinculados, desactivados: desactivados, dados_de_baja: inactivos };
  },

  // ---------------- 2) Conductores activos ----------------
  conductores: function (drivers) {
    return this.fusionar_('conductor', drivers.filter((d) => d.driverActivationStatus !== 'deactivated').map((d) => ({ id: d.id, nombre: d.name })));
  },

  // ---------------- 3) Remolques y dollys ----------------
  remolques: function (trailers, tags) {
    let arbol = { porId: {} };
    try { arbol = this.arbol_(tags); } catch (e) { /* sin GRUPO GAL: solo por nombre */ }
    const bajas = String(CONFIG.SAMSARA.ETIQUETAS_REMOLQUE_INACTIVO || '').split(',').map((x) => this.K(x)).filter(Boolean);
    const items = {};   // id -> { id, nombre, tipo, estatus }
    // a) Trailers: tipo por etiqueta (uso efectivo) o por nombre; baja por etiquetas configuradas
    (trailers || []).forEach((t) => {
      const usos = (t.tags || []).map((g) => (arbol.porId[g.id] || {}).uso).filter(Boolean);
      let tipo = usos.indexOf('dolly') !== -1 ? 'dolly' : usos.indexOf('remolque') !== -1 ? 'remolque' : '';
      if (!tipo) tipo = CONFIG.SAMSARA.PATRON_DOLLY.test(String(t.name || '')) ? 'dolly' : 'remolque';
      const deBaja = (t.tags || []).some((g) => bajas.indexOf(this.K(g.name)) !== -1) || /^DEACTIVATED/i.test(String(t.name || ''));
      items[t.id] = { id: t.id, nombre: String(t.name || '').replace(/^DEACTIVATED,?\s*/i, ''), tipo: tipo, estatus: deBaja ? 'Inactivo' : 'Activo' };
    });
    // b) Activos de las etiquetas Remolques…/Dolly… (los dollys solo existen así en Samsara)
    Object.keys(arbol.porId).forEach((id) => {
      const n = arbol.porId[id];
      if (n.uso !== 'dolly' && n.uso !== 'remolque') return;
      (n.tag.assets || []).forEach((a) => {
        if (!a || !a.id) return;
        if (items[a.id]) { if (n.uso === 'dolly') items[a.id].tipo = 'dolly'; return; }
        items[a.id] = { id: a.id, nombre: a.name || String(a.id), tipo: n.uso, estatus: 'Activo' };
      });
    });
    const lista = Object.keys(items).map((k) => items[k]);
    return {
      dollys: this.fusionar_('dolly', lista.filter((x) => x.tipo === 'dolly')),
      remolques: this.fusionar_('remolque', lista.filter((x) => x.tipo === 'remolque')),
    };
  },
};
