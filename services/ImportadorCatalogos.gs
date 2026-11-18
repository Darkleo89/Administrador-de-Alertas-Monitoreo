/**
 * Importa la semilla generada por herramientas/generar_semilla.py (Excel de catálogos ya depurado).
 * Es idempotente: cada registro se busca por nombre normalizado (sin acentos ni mayúsculas) y se
 * actualiza si existe, así que se puede ejecutar varias veces sin duplicar.
 * Portable: solo usa DB, CatalogoService y AuthService.
 */
const ImportadorCatalogos = {
  importar: function (semilla, opciones) {
    opciones = opciones || {};
    const K = (s) => CatalogoService.clave(s);
    const ahora = new Date();
    const r = { circuitos: [0, 0], tipos: [0, 0], listas: [0, 0], catalogos: [0, 0], unidades: [0, 0], etiquetas: [0, 0], usuarios: [], omitidos: [] };
    const upsert = (tabla, filas, claveDe, existentesClave, contador) => {
      const repo = DB.table(tabla);
      const existentes = {};
      repo.all().forEach((x) => { existentes[existentesClave(x)] = x; });
      const nuevos = [];
      const patches = {};
      filas.forEach((f) => {
        const ex = existentes[claveDe(f)];
        if (ex) { patches[ex.id] = f; contador[1]++; }
        else { nuevos.push(f); contador[0]++; }
      });
      repo.updateMany(patches);
      return repo.insertMany(nuevos);
    };

    // 1) Circuitos
    upsert('circuitos', semilla.circuitos.map((c) => ({ nombre: c.nombre, activo: c.activo !== false })),
      (f) => K(f.nombre), (x) => K(x.nombre), r.circuitos);
    const idCircuito = {};
    DB.table('circuitos').all().forEach((c) => { idCircuito[K(c.nombre)] = c.id; });

    // 2) Tipos de incidencia (no pisa ajustes de SLA hechos por el Admin si ya existen)
    const tiposEx = {};
    DB.table('tipos_incidencia').all().forEach((t) => { tiposEx[K(t.nombre)] = t; });
    upsert('tipos_incidencia', semilla.tipos.map((t) => {
      const ex = tiposEx[K(t.nombre)];
      return {
        nombre: t.nombre, clasificacion: t.clasificacion, activo: t.activo !== false, orden: t.orden,
        severidad: ex && ex.severidad ? ex.severidad : t.severidad,
        escalamiento_inmediato: ex && ex.escalamiento_inmediato !== null && ex.escalamiento_inmediato !== undefined && ex.escalamiento_inmediato !== '' ? ex.escalamiento_inmediato : t.escalamiento_inmediato,
        sla_primer_estatus_min: ex ? ex.sla_primer_estatus_min : '', sla_escalamiento_min: ex ? ex.sla_escalamiento_min : '',
        actualizado_en: ahora,
      };
    }), (f) => K(f.nombre), (x) => K(x.nombre), r.tipos);
    const idTipo = {};
    DB.table('tipos_incidencia').all().forEach((t) => { idTipo[K(t.nombre)] = t.id; });

    // 3) Listas de distribución (+ respaldo)
    const filasListas = semilla.listas.map((l) => ({
      nombre: l.nombre, circuito_id: idCircuito[K(l.circuito)] || '', activa: true, es_respaldo: false,
      tipo_ids: l.tipos.map((t) => idTipo[K(t)]).filter(Boolean).join(';'), correos: l.correos.join(', '), actualizado_en: ahora,
    }));
    if (semilla.respaldo) {
      filasListas.push({ nombre: semilla.respaldo.nombre, circuito_id: '', tipo_ids: '', activa: true, es_respaldo: true,
        correos: semilla.respaldo.correos.join(', '), actualizado_en: ahora });
    }
    upsert('listas_distribucion', filasListas, (f) => K(f.nombre), (x) => K(x.nombre), r.listas);

    // 4) Catálogos simples (clave: tipo + nombre normalizado + circuito; si existe, actualiza estatus y origen)
    upsert('catalogos', semilla.catalogos.map((c) => ({
      tipo: c.tipo, nombre: c.nombre, circuito_id: c.circuito ? (idCircuito[K(c.circuito)] || '') : '',
      estatus: c.estatus || 'Activo', origen: c.origen || 'excel', actualizado_en: ahora,
    })), (f) => f.tipo + '|' + K(f.nombre) + '|' + (f.circuito_id || ''), (x) => x.tipo + '|' + K(x.nombre) + '|' + (x.circuito_id || ''), r.catalogos);

    // 5) Unidades: solo asigna circuito (la fuente principal es Samsara; no toca estación ni ids de Samsara)
    const unidades = DB.table('unidades');
    const porEco = {};
    unidades.all().forEach((u) => { porEco[K(u.economico)] = u; });
    const patchU = {};
    const nuevasU = [];
    semilla.unidades.forEach((u) => {
      const ex = porEco[K(u.economico)];
      const cid = idCircuito[K(u.circuito)] || '';
      if (ex) { if (!ex.circuito_id) { patchU[ex.id] = { circuito_id: cid }; r.unidades[1]++; } }
      else { nuevasU.push({ economico: u.economico, circuito_id: cid, activo: u.activo !== false, origen: 'excel' }); r.unidades[0]++; }
    });
    unidades.updateMany(patchU);
    unidades.insertMany(nuevasU);

    // 6) Etiquetas de Samsara -> uso / circuito
    upsert('etiquetas_samsara', semilla.etiquetas.map((e) => ({
      etiqueta: e.etiqueta, uso: e.uso, circuito_id: e.circuito ? (idCircuito[K(e.circuito)] || '') : '', activo: true,
    })), (f) => K(f.etiqueta), (x) => K(x.etiqueta), r.etiquetas);

    // 7) Usuarios: contraseña temporal NUEVA (nunca se importan contraseñas)
    if (opciones.usuarios !== false) {
      (semilla.usuarios || []).forEach((u) => {
        if (AuthService.buscarPorUsuario(u.usuario)) { r.omitidos.push(u.usuario + ' (ya existe)'); return; }
        try {
          const x = AuthService.guardarUsuario({ usuario: u.usuario, nombre: u.nombre, rol: u.rol, activo: u.activo !== false }, { rol: 'Admin', id: '', login: 'importador' });
          r.usuarios.push({ usuario: u.usuario, nombre: u.nombre, rol: u.rol, rol_origen: u.rol_origen, activo: u.activo !== false, password_temporal: x.password_temporal });
        } catch (e) { r.omitidos.push(u.usuario + ' (' + e.message + ')'); }
      });
    }
    return r;
  },
};
