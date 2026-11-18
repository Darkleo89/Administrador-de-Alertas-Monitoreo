/**
 * Estaciones y unidades desde las etiquetas (tags) de Samsara.
 *
 *   Monitoreo                      <- etiqueta padre (CONFIG.SAMSARA.TAG_PADRE_ESTACIONES)
 *     ├─ Estacion Base Mexico      <- cada etiqueta hija = una estación
 *     ├─ Estacion Celaya              (sus vehículos = las unidades que atiende)
 *     └─ ...
 *
 * - Crea/renombra estaciones por samsara_tag_id; desactiva las que ya no existen en Samsara.
 * - Crea/actualiza unidades por samsara_asset_id (número económico = nombre del vehículo).
 *   Una unidad que ya no tiene etiqueta de estación queda "Sin estación".
 * - Reubica las alarmas NUEVAS de unidades que cambiaron de estación.
 */
const CatalogoSamsaraService = {
  normalizar_: function (s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  },

  sincronizar: function () {
    const tags = SamsaraClient.listarTags();
    const objetivo = this.normalizar_(CONFIG.SAMSARA.TAG_PADRE_ESTACIONES);
    const padre = tags.find((t) => this.normalizar_(t.name) === objetivo && !t.parentTagId) ||
                  tags.find((t) => this.normalizar_(t.name) === objetivo);
    if (!padre) throw new Error('No existe la etiqueta "' + CONFIG.SAMSARA.TAG_PADRE_ESTACIONES + '" en Samsara (o el token no tiene permiso de lectura de etiquetas).');
    const hijas = tags.filter((t) => t.parentTagId === padre.id || (t.parentTag && t.parentTag.id === padre.id));
    if (!hijas.length) throw new Error('La etiqueta "' + padre.name + '" no tiene etiquetas hijas (estaciones).');

    const ahora = new Date();
    const resumen = { estaciones_nuevas: 0, estaciones_actualizadas: 0, estaciones_desactivadas: 0,
                      unidades_nuevas: 0, unidades_actualizadas: 0, unidades_sin_estacion: 0, conflictos: [], alarmas_reubicadas: 0 };

    // ---- Estaciones ----
    const repoEst = DB.table('estaciones');
    const estaciones = repoEst.all();
    const porTag = {};
    const patchesEst = {};
    hijas.forEach((tag) => {
      const e = estaciones.find((x) => String(x.samsara_tag_id) === String(tag.id));
      if (e) {
        porTag[tag.id] = e.id;
        if (e.nombre !== tag.name || e.activa === false) resumen.estaciones_actualizadas++;
        patchesEst[e.id] = { nombre: tag.name, activa: true, sincronizado_en: ahora };
      } else {
        const nueva = repoEst.insert({ nombre: tag.name, descripcion: 'Etiqueta Samsara: ' + padre.name + ' / ' + tag.name,
          activa: true, origen: 'samsara', samsara_tag_id: tag.id, sincronizado_en: ahora });
        porTag[tag.id] = nueva.id;
        resumen.estaciones_nuevas++;
      }
    });
    estaciones.filter((e) => e.samsara_tag_id && !hijas.some((t) => String(t.id) === String(e.samsara_tag_id)) && e.activa !== false)
      .forEach((e) => { patchesEst[e.id] = { activa: false, sincronizado_en: ahora }; resumen.estaciones_desactivadas++; });
    repoEst.updateMany(patchesEst);

    // ---- Unidades: vehículo -> estación ----
    const asignacion = {};   // assetId -> { nombre, estacion_id, tag }
    // Remolques, dollys y mamparas también llevan etiqueta de estación, pero no son unidades (no generan alarmas
    // de cámara): se excluyen usando lo que la sincronización de catálogos ya identificó como tales.
    const noUnidad = {};
    DB.table('catalogos').where((c) => c.tipo === 'remolque' || c.tipo === 'dolly').forEach((c) => {
      noUnidad[this.normalizar_(c.nombre)] = true;
      if (c.externo_id) noUnidad['id:' + c.externo_id] = true;
    });
    DB.table('unidades').where((u) => u.origen === 'remolque').forEach((u) => {
      noUnidad[this.normalizar_(u.economico)] = true;
      if (u.samsara_asset_id) noUnidad['id:' + u.samsara_asset_id] = true;
    });
    const esUnidad = (v) => !noUnidad['id:' + v.id] && !noUnidad[this.normalizar_(v.name)];
    hijas.forEach((tag) => {
      (tag.vehicles || []).concat(tag.assets || []).forEach((v) => {
        if (!v || !v.id || !esUnidad(v)) return;
        if (asignacion[v.id] && asignacion[v.id].estacion_id !== porTag[tag.id]) {
          resumen.conflictos.push((v.name || v.id) + ' está en "' + asignacion[v.id].tag + '" y en "' + tag.name + '" (se queda en la primera)');
          return;
        }
        asignacion[v.id] = { nombre: v.name || String(v.id), estacion_id: porTag[tag.id], tag: tag.name };
      });
    });

    const repoUni = DB.table('unidades');
    const unidades = repoUni.all();
    const patchesUni = {};
    const nuevas = [];
    const cambios = {};      // assetId -> nueva estación (para reubicar alarmas)
    Object.keys(asignacion).forEach((assetId) => {
      const a = asignacion[assetId];
      const u = unidades.find((x) => String(x.samsara_asset_id) === String(assetId)) ||
                unidades.find((x) => !x.samsara_asset_id && this.normalizar_(x.economico) === this.normalizar_(a.nombre));
      if (u) {
        if (u.estacion_id !== a.estacion_id || u.economico !== a.nombre) { resumen.unidades_actualizadas++; cambios[assetId] = a.estacion_id; }
        patchesUni[u.id] = { economico: a.nombre, samsara_asset_id: assetId, estacion_id: a.estacion_id, activo: true, origen: 'samsara', sincronizado_en: ahora };
      } else {
        nuevas.push({ economico: a.nombre, samsara_asset_id: assetId, estacion_id: a.estacion_id, activo: true, origen: 'samsara', sincronizado_en: ahora });
        cambios[assetId] = a.estacion_id;
      }
    });
    // Unidades de Samsara que ya no tienen etiqueta de estación
    unidades.filter((u) => u.origen === 'samsara' && u.samsara_asset_id && !asignacion[u.samsara_asset_id] && u.estacion_id)
      .forEach((u) => { patchesUni[u.id] = { estacion_id: '', sincronizado_en: ahora }; cambios[u.samsara_asset_id] = ''; resumen.unidades_sin_estacion++; });
    repoUni.updateMany(patchesUni);
    repoUni.insertMany(nuevas);
    resumen.unidades_nuevas = nuevas.length;

    // ---- Alarmas nuevas de unidades que cambiaron de estación ----
    const patchesAl = {};
    DB.table('alarmas').where((x) => x.estatus === 'nueva' && x.samsara_asset_id && cambios.hasOwnProperty(String(x.samsara_asset_id)))
      .forEach((x) => { if (String(x.estacion_id || '') !== String(cambios[x.samsara_asset_id] || '')) patchesAl[x.id] = { estacion_id: cambios[x.samsara_asset_id] }; });
    resumen.alarmas_reubicadas = DB.table('alarmas').updateMany(patchesAl);

    resumen.estaciones = hijas.map((t) => t.name + ' (' + ((t.vehicles || []).length + (t.assets || []).length) + ' unidades)');
    Parametros.set('estaciones_ultima_sync', ahora.toISOString());
    Parametros.set('estaciones_ultimo_resumen', JSON.stringify(resumen).slice(0, 2000));
    return resumen;
  },

  /** Ids de etiquetas de estaciones activas (para filtrar la ingesta de alarmas). */
  tagIdsActivos: function () {
    return DB.table('estaciones').where((e) => e.activa !== false && e.samsara_tag_id).map((e) => String(e.samsara_tag_id));
  },
};
