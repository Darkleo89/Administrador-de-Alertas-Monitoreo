/**
 * Utilidades de negocio compartidas por los servicios (portables, sin APIs de Google).
 */
const Parametros = {
  get: function (clave) {
    const r = DB.table('parametros').find(clave);
    return r ? r.valor : null;
  },
  set: function (clave, valor) {
    const repo = DB.table('parametros');
    const datos = { valor: valor === null || valor === undefined ? '' : String(valor), actualizado_en: new Date() };
    if (!repo.update(clave, datos)) repo.insert(Object.assign({ id: clave }, datos));
  },
  /** Consecutivo atómico (para folios). */
  siguiente: function (clave) {
    const repo = DB.table('parametros');
    const r = repo.updateIf(clave, () => true, (row) => ({ valor: String(Number(row.valor || 0) + 1), actualizado_en: new Date() }));
    if (r) return Number(r.valor);
    repo.insert({ id: clave, valor: '1', actualizado_en: new Date() });
    return 1;
  },
};

/** Registro de auditoría (bitácora) de cada acción sobre alarmas y tickets. */
function bitacora_(alarmaId, ticketId, usuario, accion, nota) {
  DB.table('seguimientos').insert({
    alarma_id: alarmaId || '', ticket_id: ticketId || '', usuario: usuario,
    accion: accion, nota: nota || '', creado_en: new Date(),
  });
}

/** Número de semana ISO-8601 (lunes a domingo), como en la plantilla "Semana No.". */
function semanaIso_(fecha) {
  const d = new Date(Date.UTC(fecha.getFullYear(), fecha.getMonth(), fecha.getDate()));
  const dia = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dia);
  const inicioAnio = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - inicioAnio) / 86400000 + 1) / 7);
}

/** Datos del último ticket de cada unidad, para precargar el formulario (remolques, ruta, cliente…). */
function ultimosDatosPorUnidad_() {
  const campos = ['operador', 'remolque1', 'remolque2', 'dolly', 'ruta', 'circuito', 'operacion', 'cliente', 'supervisor'];
  const mapa = {};
  DB.table('tickets').all().sort((a, b) => new Date(a.creado_en) - new Date(b.creado_en)).forEach((t) => {
    if (!t.unidad_id) return;
    const r = {};
    campos.forEach((c) => { r[c] = t[c] || ''; });
    mapa[t.unidad_id] = r;
  });
  return mapa;
}

function minutosEntre_(a, b) {
  if (!a || !b) return null;
  return (new Date(b).getTime() - new Date(a).getTime()) / 60000;
}

function esSupervision_(usuario) {
  return CONFIG.ROLES_SUPERVISION.indexOf(usuario.rol) !== -1;
}

/** Un monitorista ve su estación y las alarmas sin estación asignada; supervisión ve todo. */
function puedeVerEstacion_(usuario, estacionId) {
  if (esSupervision_(usuario)) return true;
  if (CONFIG.ROLES_CON_TURNO.indexOf(usuario.rol) === -1) return true;  // áreas (Mantenimiento, Jurídico…) ven todo
  return !estacionId || estacionesDelGrupo_(usuario.estacion_id).indexOf(String(estacionId)) !== -1;
}

/**
 * Estaciones que ve quien trabaja en `estacionId`: la suya y las de su grupo de apoyo
 * (estaciones.grupo igual, p. ej. México 1 y Base México se ayudan). Se calcula una vez por ejecución.
 */
let GRUPOS_ESTACION_ = null;
function estacionesDelGrupo_(estacionId) {
  const id = String(estacionId || '');
  if (!id) return [];
  if (!GRUPOS_ESTACION_) {
    const porGrupo = {}, grupoDe = {};
    DB.table('estaciones').all().forEach((e) => {
      const g = CatalogoService.clave(e.grupo);
      if (!g || e.activa === false) return;
      grupoDe[String(e.id)] = g;
      (porGrupo[g] = porGrupo[g] || []).push(String(e.id));
    });
    GRUPOS_ESTACION_ = { porGrupo: porGrupo, grupoDe: grupoDe };
  }
  const g = GRUPOS_ESTACION_.grupoDe[id];
  return g ? [id].concat(GRUPOS_ESTACION_.porGrupo[g].filter((x) => x !== id)) : [id];
}
function olvidarGruposEstacion_() { GRUPOS_ESTACION_ = null; }

/** Área que atiende una alarma o ticket. Lo anterior a Seguridad Vial es de Monitoreo. */
function bandejaDe_(x) {
  return x && x.bandeja === 'seguridad_vial' ? 'seguridad_vial' : 'monitoreo';
}

/**
 * Áreas que ve un usuario: Monitorista = Monitoreo; Seguridad Vial = Seguridad Vial;
 * Supervisor = la de su campo `area` (jefe de esa área) o todas; Admin y demás roles = todas.
 */
function bandejasDeUsuario_(u) {
  const todas = Object.keys(CONFIG.BANDEJAS);
  if (u.rol === 'Monitorista') return ['monitoreo'];
  if (u.rol === 'Seguridad Vial') return ['seguridad_vial'];
  if (u.rol === 'Supervisor' && u.area && todas.indexOf(u.area) !== -1) return [u.area];
  return todas;
}

/** ¿El usuario puede ver/atender esta alarma o ticket? Seguridad Vial no depende de la estación (toda la flota). */
function puedeVer_(usuario, item) {
  const b = bandejaDe_(item);
  if (bandejasDeUsuario_(usuario).indexOf(b) === -1) return false;
  if (b === 'seguridad_vial') return true;
  // Alerta que ven varias estaciones: la ve cualquiera de ellas hasta que alguien la toma
  const lista = estacionesDe_(item);
  if (lista.length && !item.estacion_id) {
    if (esSupervision_(usuario) || CONFIG.ROLES_CON_TURNO.indexOf(usuario.rol) === -1) return true;
    return estacionesDelGrupo_(usuario.estacion_id).some((e) => lista.indexOf(e) !== -1);
  }
  return puedeVerEstacion_(usuario, item.estacion_id);
}

/** Estaciones que ven una alarma (de su alerta en Samsara). Vacío = solo la de estacion_id. */
function estacionesDe_(item) {
  return String((item && item.estaciones) || '').split(';').map((x) => x.trim()).filter(Boolean);
}

/** ¿La alarma es de esta estación? (su estación, o una de las que la ven mientras nadie la toma) */
function esDeEstacion_(item, estacionId) {
  if (String(item.estacion_id || '') === String(estacionId)) return true;
  return !item.estacion_id && estacionesDe_(item).indexOf(String(estacionId)) !== -1;
}

function ordenSeveridad_(s) {
  const i = CONFIG.SEVERIDADES.indexOf(s);
  return i === -1 ? CONFIG.SEVERIDADES.length : i;
}

/** Busca la unidad por id de Samsara o por número económico. */
function buscarUnidad_(unidades, assetId, nombre) {
  return unidades.find((u) => assetId && String(u.samsara_asset_id) === String(assetId)) ||
         unidades.find((u) => nombre && String(u.economico).toLowerCase() === String(nombre).toLowerCase()) || null;
}
