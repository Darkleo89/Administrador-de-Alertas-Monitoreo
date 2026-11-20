/**
 * Inicio de Configuración: un resumen por grupo con lo que requiere atención
 * (catálogos por validar, listas sin correos, huecos de cobertura, errores de Samsara…).
 * Solo lee. El Supervisor recibe lo de su alcance (personas, estaciones y catálogos); el Admin, todo.
 */
const ConfiguracionService = {
  resumen: function (usuario) {
    const esAdmin = usuario.rol === 'Admin';
    const ahora = Date.now();
    const usuarios = DB.table('usuarios').all().filter((u) => u.activo !== false);
    const estaciones = DB.table('estaciones').all().filter((e) => e.activa !== false);
    const grupos = {};
    estaciones.forEach((e) => { const g = CatalogoService.clave(e.grupo); if (g) grupos[g] = true; });
    const cat = CatalogoAdminService.resumen();
    let porValidar = 0;
    Object.keys(cat).forEach((t) => { porValidar += cat[t].por_validar || 0; });

    const out = {
      es_admin: esAdmin,
      personas: {
        usuarios_activos: usuarios.length,
        bloqueados: usuarios.filter((u) => u.bloqueado_hasta && new Date(u.bloqueado_hasta).getTime() > ahora).length,
        clave_temporal: usuarios.filter((u) => u.debe_cambiar_password === true).length,
        analistas_sv: usuarios.filter((u) => u.rol === 'Seguridad Vial').length,
        estaciones_activas: estaciones.length,
        grupos_apoyo: Object.keys(grupos).length,
      },
      catalogos: {
        por_validar: porValidar,
        tipos_activos: CatalogoService.tipos(true).length,
        circuitos_activos: CatalogoService.circuitos(true).length,
      },
    };
    if (!esAdmin) return out;

    const cob = CatalogoService.cobertura();
    const listas = DB.table('listas_distribucion').all().filter((l) => l.activa !== false);
    const sinCorreos = listas.filter((l) => !String(l.correos || '').trim()).map((l) => l.nombre);
    if (!listas.some((l) => l.es_seguridad_vial === true)) sinCorreos.push('Lista Seguridad Vial');
    out.avisos = { listas_activas: listas.length, sin_correos: sinCorreos, huecos: cob.huecos || 0, dobles: cob.dobles || 0 };

    const alertas = DB.table('alertas_samsara').all();
    const semana = ahora - 7 * 864e5;
    out.samsara = {
      ingesta_ultima: Parametros.get('samsara_ultima_sync') || '',
      ingesta_error: Parametros.get('samsara_ultimo_error') || '',
      estaciones_ultima: Parametros.get('estaciones_ultima_sync') || '',
      estaciones_error: Parametros.get('estaciones_ultimo_error') || '',
      catalogos_error: Parametros.get('catalogos_ultimo_error') || '',
      alertas_ultima: Parametros.get('alertas_samsara_sync') || '',
      alertas_nuevas_7d: alertas.filter((a) => a.origen !== 'seguridad' && a.creado_en && new Date(a.creado_en).getTime() >= semana).map((a) => a.nombre),
      alertas_ya_no_existen: alertas.filter((a) => a.en_samsara === false && AlertasSamsaraService.destinoDe(a) !== 'ninguno').length,
      etiquetas_sin_asignar: DB.table('etiquetas_samsara').where((e) => e.activo !== false && (!e.uso || e.uso === 'sin_asignar')).length,
    };
    // Espacio: lo que ocupan las evidencias registradas y el uso de la cuenta de Google (integración Archivos)
    let espacio = null;
    try { espacio = Archivos.espacio(); } catch (e) { console.warn('Espacio de Drive: ' + e.message); }
    out.sistema = {
      evidencias_bytes: DB.table('evidencias').all().filter((e) => e.estado !== 'subiendo' && String(e.alarma_id || '').indexOf('eliminada:') !== 0)
        .reduce((s, e) => s + (Number(e.tamano) || 0), 0),
      espacio_usado: espacio ? espacio.usado : null, espacio_limite: espacio ? espacio.limite : null,
    };
    return out;
  },
};
