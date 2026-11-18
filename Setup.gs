/**
 * Funciones de administración. Ejecútalas desde el EDITOR de Apps Script (selector de funciones + ▶).
 * Están protegidas con soloEditor_(): si alguien intenta llamarlas desde la web app, fallan.
 *
 *  setup()                       Crea/actualiza la BD, crea el usuario "admin" (si no existe) y programa los triggers.
 *  seedDemo()                    Carga estaciones, unidades, áreas, usuarios y alarmas de prueba (idempotente).
 *  restablecerAdmin()            Genera una nueva contraseña temporal para el usuario "admin".
 *  simularAlarmaSamsara()        Inserta un evento de Samsara simulado.
 *  probarSamsara()               Verifica el token y muestra cuántos eventos devuelve la API.
 *  sincronizarEstacionesSamsara()  Estaciones = etiquetas hijas de "Monitoreo"; unidades = sus vehículos.
 *  importarCatalogos()           Carga tipos de incidencia, circuitos, listas, clientes, rutas... del Excel depurado.
 *  sincronizarCatalogosSamsara() Circuito de cada unidad (GRUPO GAL), conductores activos, remolques y dollys.
 *  verConfiguracionesAlertasSamsara()  Lista las alertas configuradas en Samsara (se administran en Configuración → Samsara → Alertas y cámaras).
 *  limpiarAlarmasYTickets()      Borra alarmas, tickets y seguimientos (conserva encabezados). ¡Solo pruebas!
 */

/** Permite ejecutar solo desde el editor por el dueño del script (no desde la web app anónima). */
function soloEditor_() {
  const activo = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  const dueno = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (!activo || activo !== dueno) throw new Error('Esta función solo se ejecuta desde el editor de Apps Script.');
}

function setup() {
  soloEditor_();
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('SPREADSHEET_ID');
  if (!id) {
    id = SpreadsheetApp.create('Monitoreo de Flota - BD').getId();
    props.setProperty('SPREADSHEET_ID', id);
  }
  props.setProperty('ADMIN_EMAIL', Session.getEffectiveUser().getEmail());

  const adapter = new SheetsAdapter(id);
  Object.keys(SCHEMA).forEach((t) => adapter.ensureTable(t, SCHEMA[t]));
  ['Hoja 1', 'Sheet1'].forEach((n) => {
    const h = adapter.ss.getSheetByName(n);
    if (h && adapter.ss.getSheets().length > 1) adapter.ss.deleteSheet(h);
  });

  // Usuario administrador inicial
  if (!DB.table('usuarios').where((u) => u.rol === 'Admin' && u.password_hash).length) {
    const r = AuthService.guardarUsuario({ usuario: 'admin', nombre: 'Administrador', rol: 'Admin', email: props.getProperty('ADMIN_EMAIL') }, { rol: 'Admin', id: '' });
    console.log('USUARIO ADMIN CREADO → usuario: admin   contraseña temporal: ' + r.password_temporal + '   (te pedirá cambiarla)');
  }

  // Triggers (se recrean para no duplicarlos)
  ScriptApp.getProjectTriggers()
    .filter((t) => ['job_sincronizarSamsara', 'job_cicloMonitoreo'].indexOf(t.getHandlerFunction()) !== -1)
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('job_cicloMonitoreo').timeBased().everyMinutes(CONFIG.SAMSARA.INTERVALO_MIN).create();
  ScriptApp.newTrigger('job_sincronizarSamsara').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(0).create();

  console.log('BD lista: https://docs.google.com/spreadsheets/d/' + id);
}

/** Crea el usuario "admin" si no existe, o le genera una nueva contraseña temporal. */
function restablecerAdmin() {
  soloEditor_();
  // Asegura que la hoja tenga las columnas de login (por si setup() no se ha vuelto a ejecutar)
  const adapter = new SheetsAdapter(getSetting_('SPREADSHEET_ID', true));
  ['usuarios', 'sesiones', 'turnos'].forEach((t) => adapter.ensureTable(t, SCHEMA[t]));

  const admin = AuthService.buscarPorUsuario('admin');
  let clave;
  if (!admin) {
    clave = AuthService.guardarUsuario({ usuario: 'admin', nombre: 'Administrador', rol: 'Admin', email: getSetting_('ADMIN_EMAIL', false) || '' }, { rol: 'Admin', id: '' }).password_temporal;
    console.log('Se CREÓ el usuario admin.');
  } else {
    clave = AuthService.restablecerPassword(admin.id, { rol: 'Admin', id: '' }).password_temporal;
    DB.table('usuarios').update(admin.id, { activo: true, rol: 'Admin' });
  }
  console.log('=====================================================');
  console.log('  Usuario:              admin');
  console.log('  Contraseña temporal:  ' + clave);
  console.log('  (al entrar te pedirá cambiarla)');
  console.log('=====================================================');
}

/**
 * Trigger cada minuto: alarmas de Samsara, escalamiento por SLA y cierre de turnos olvidados.
 * Es invocable desde el navegador (los triggers no pueden usar funciones privadas), por eso
 * no devuelve datos y se limita a una ejecución cada 30 s.
 */
function job_cicloMonitoreo() {
  ConfigService.aplicar();
  try { Migraciones.aplicarPendientes(); } catch (e) { console.error('Migraciones: ' + e.message); }
  const ultimo = Parametros.get('ciclo_ultimo');
  if (ultimo && Date.now() - new Date(ultimo).getTime() < 30000) return;
  Parametros.set('ciclo_ultimo', new Date().toISOString());

  if (getSetting_('SAMSARA_API_TOKEN', false)) {
    // Estaciones y unidades desde las etiquetas de Samsara (cada CONFIG.SAMSARA.SYNC_ESTACIONES_MIN)
    const vencido = (clave) => { const u = Parametros.get(clave); return !u || Date.now() - new Date(u).getTime() > CONFIG.SAMSARA.SYNC_ESTACIONES_MIN * 60000; };
    if (vencido('estaciones_ultima_sync')) {
      try { CatalogoSamsaraService.sincronizar(); Parametros.set('estaciones_ultimo_error', ''); }
      catch (e) { Parametros.set('estaciones_ultimo_error', new Date().toISOString() + ' ' + e.message); console.error(e); }
    } else if (vencido('catalogos_ultima_sync')) {
      // Circuitos (GRUPO GAL), conductores y remolques: en otro ciclo para no alargar este.
      try {
        const r = SincronizacionCatalogos.ejecutar();
        Parametros.set('catalogos_ultimo_error', r.errores.join(' | '));
        try { AlertasSamsaraService.sincronizar(); } catch (e) { console.error(e); }   // alertas configuradas nuevas
      } catch (e) { Parametros.set('catalogos_ultimo_error', new Date().toISOString() + ' ' + e.message); Parametros.set('catalogos_ultima_sync', new Date().toISOString()); console.error(e); }
    }
    try {
      const ids = String(getSetting_('SAMSARA_ALERT_CONFIG_IDS', false) || '').split(/[,\s]+/).filter(Boolean);
      const n = IngestaSamsaraService.ejecutar(ids);
      Parametros.set('samsara_ultima_sync', new Date().toISOString());
      Parametros.set('samsara_ultimo_error', '');
      if (n) console.log('Alarmas nuevas de Samsara: ' + n);
    } catch (e) {
      Parametros.set('samsara_ultimo_error', new Date().toISOString() + ' ' + e.message);
      console.error(e);
    }
  }
  const escalados = TicketService.revisarSla();
  if (escalados) console.log('Tickets escalados por SLA: ' + escalados);
  const turnos = TurnoService.cerrarVencidos();
  if (turnos) console.log('Turnos cerrados automáticamente: ' + turnos);
}

function job_sincronizarSamsara() {
  ConfigService.aplicar();
  const ultimo = Parametros.get('capacitacion_ultimo');
  if (ultimo && Date.now() - new Date(ultimo).getTime() < 3600000) return;
  Parametros.set('capacitacion_ultimo', new Date().toISOString());
  if (!getSetting_('SAMSARA_API_TOKEN', false)) { console.warn('Sin SAMSARA_API_TOKEN; se omite.'); return; }
  console.log('Operadores sincronizados: ' + CapacitacionService.sincronizarSamsara());
}

function probarSamsara() {
  soloEditor_();
  const r = SamsaraClient.safetyEventsStream({ startTime: new Date(Date.now() - 24 * 3600000).toISOString(), includeAsset: true });
  console.log('Token OK. Eventos de seguridad últimas 24 h (1a página): ' + (r.data || []).length);
  if (r.data && r.data[0]) console.log('Ejemplo mapeado: ' + JSON.stringify(IngestaSamsaraService.mapearEventoSeguridad(r.data[0])));
}

/**
 * Importa los catálogos del negocio (Excel ya depurado por herramientas/generar_semilla.py).
 * Se puede ejecutar varias veces: no duplica. Después de importar, borra src/datos/SemillaCatalogos.gs
 * del proyecto y vuelve a subir (contiene correos del personal).
 */
function importarCatalogos() {
  soloEditor_();
  if (typeof SEMILLA_CATALOGOS_ === 'undefined') {
    throw new Error('No hay datos para importar. Genera la semilla con: python -I herramientas/generar_semilla.py y súbela con clasp push.');
  }
  const r = ImportadorCatalogos.importar(SEMILLA_CATALOGOS_);
  const f = (x) => x[0] + ' nuevos, ' + x[1] + ' actualizados';
  console.log('Semilla del ' + SEMILLA_CATALOGOS_.generado);
  console.log('Circuitos: ' + f(r.circuitos) + ' | Tipos de incidencia: ' + f(r.tipos) + ' | Listas: ' + f(r.listas));
  console.log('Catálogos (clientes, supervisores, conductores, remolques, dollys, rutas): ' + f(r.catalogos));
  console.log('Unidades: ' + f(r.unidades) + ' | Etiquetas Samsara: ' + f(r.etiquetas));
  if (r.usuarios.length) {
    console.log('USUARIOS CREADOS (entrega cada contraseña temporal en persona; se pide cambiarla al entrar):');
    r.usuarios.forEach((u) => console.log('  ' + u.usuario + '  |  ' + u.nombre + '  |  ' + u.rol + (u.rol_origen !== u.rol ? ' (en el Excel: ' + u.rol_origen + ')' : '') +
      (u.activo ? '' : '  |  INACTIVO') + '  |  contraseña temporal: ' + u.password_temporal));
  }
  if (r.omitidos.length) console.log('Usuarios omitidos: ' + r.omitidos.join(', '));
  console.log('COBERTURA (tipos activos sin lista en el circuito; esos tickets irán a la lista de respaldo):');
  CatalogoService.resumenHuecos().forEach((l) => console.log('  ' + l));
}

/** Circuito de cada unidad (GRUPO GAL), conductores activos y remolques/dollys desde Samsara. */
function sincronizarCatalogosSamsara() {
  soloEditor_();
  ConfigService.aplicar();
  const m = Migraciones.aplicarPendientes();
  if (m.length) console.log('Migraciones aplicadas: ' + m.join(', '));
  const r = SincronizacionCatalogos.ejecutar();
  const c = r.circuitos;
  console.log('CIRCUITOS: ' + c.unidades_con_circuito + ' unidades con circuito en Samsara (' + c.unidades_cambiaron + ' cambiaron, ' + c.unidades_nuevas + ' nuevas)');
  console.log('  Remolques/dollys/mamparas retirados de la tabla de unidades: ' + c.retirados_de_unidades);
  console.log('  Unidades activas sin circuito: ' + c.unidades_sin_circuito + (c.ejemplos_sin_circuito.length ? ' (p. ej. ' + c.ejemplos_sin_circuito.join(', ') + ')' : ''));
  if (c.etiquetas_nuevas_sin_asignar.length) console.log('  Etiquetas NUEVAS sin asignar (asígnalas en Configuración → Samsara → Etiquetas): ' + c.etiquetas_nuevas_sin_asignar.join(', '));
  if (c.conflictos.length) console.log('  Unidades en dos circuitos: ' + c.conflictos.join(' | '));
  const f = (x) => x ? x.recibidos + ' en Samsara · ' + x.nuevos + ' nuevos · ' + x.vinculados + ' vinculados con el Excel · ' + x.desactivados + ' desactivados' + (x.dados_de_baja ? ' · ' + x.dados_de_baja + ' de baja (Bajas/Perdida Total)' : '') : 'no se pudo';
  console.log('CONDUCTORES activos: ' + f(r.conductores));
  console.log('REMOLQUES: ' + f(r.remolques && r.remolques.remolques));
  console.log('DOLLYS: ' + f(r.remolques && r.remolques.dollys));
  if (r.errores.length) console.log('ERRORES: ' + r.errores.join(' | ') + '  → revisa que el token tenga los permisos Read Drivers y Read Trailers.');
}

/**
 * Diagnóstico (solo lectura): qué hay realmente en Samsara bajo GRUPO GAL, cómo se llaman los
 * remolques/dollys y cuántas "unidades sin circuito" son en realidad remolques.
 */
function diagnosticoSamsara() {
  soloEditor_();
  ConfigService.aplicar();
  Migraciones.aplicarPendientes();
  const K = (s) => CatalogoService.clave(s);
  const tags = SamsaraClient.listarTags();
  const arbol = SincronizacionCatalogos.arbol_(tags);
  const ej = (arr) => (arr || []).slice(0, 4).map((x) => x.name || x.id).join(', ');
  console.log('ETIQUETAS bajo ' + CONFIG.SAMSARA.TAG_PADRE_CIRCUITOS + ' (uso efectivo · vehículos · activos · ejemplos):');
  Object.keys(arbol.porId).forEach((id) => {
    const n = arbol.porId[id];
    const v = n.tag.vehicles || [], a = n.tag.assets || [];
    console.log('  ' + n.tag.name + ' · ' + (n.uso || '—') + ' · ' + v.length + ' veh · ' + a.length + ' act' + (v.length || a.length ? ' · ' + ej(v.concat(a)) : ''));
  });

  const trailers = SamsaraClient.listarRemolques();
  const prefijo = (s) => String(s || '').toUpperCase().replace(/[\s\d].*$/, '').replace(/-.*$/, '') || '(sin nombre)';
  const cuenta = (arr, f) => { const c = {}; arr.forEach((x) => { const k = f(x); c[k] = (c[k] || 0) + 1; }); return Object.keys(c).sort((a, b) => c[b] - c[a]).map((k) => k + ': ' + c[k]).join(' · '); };
  console.log('TRAILERS en Samsara: ' + trailers.length + ' · por prefijo de nombre → ' + cuenta(trailers, (t) => prefijo(t.name)));
  console.log('  Etiquetas que usan los trailers → ' + cuenta([].concat.apply([], trailers.map((t) => (t.tags || []).map((g) => g.name))), (n) => n));
  console.log('  Ejemplos de nombres: ' + trailers.slice(0, 20).map((t) => t.name).join(', '));

  const nombresTrailer = {};
  trailers.forEach((t) => { nombresTrailer[K(t.name)] = true; });
  const sinCircuito = DB.table('unidades').where((u) => u.activo !== false && !u.circuito_id);
  const sonTrailer = sinCircuito.filter((u) => nombresTrailer[K(u.economico)]);
  const resto = sinCircuito.filter((u) => !nombresTrailer[K(u.economico)]);
  console.log('UNIDADES SIN CIRCUITO: ' + sinCircuito.length + ' · de ellas son remolques/trailers en Samsara: ' + sonTrailer.length + ' · resto: ' + resto.length);
  console.log('  Resto por prefijo → ' + cuenta(resto, (u) => prefijo(u.economico)));
  console.log('  Ejemplos del resto: ' + resto.slice(0, 25).map((u) => u.economico).join(', '));
}

/** Trae estaciones (etiquetas hijas de "Monitoreo") y sus unidades desde Samsara. */
function sincronizarEstacionesSamsara() {
  soloEditor_();
  const r = CatalogoSamsaraService.sincronizar();
  console.log('Estaciones: ' + r.estaciones.join(' | '));
  console.log(JSON.stringify(r, null, 2));
}

function verConfiguracionesAlertasSamsara() {
  soloEditor_();
  SamsaraClient.listarConfiguracionesAlertas().forEach((c) => console.log(c.id + '  |  ' + (c.name || '') + '  |  ' + JSON.stringify(c.triggers || c.conditions || '').slice(0, 120)));
  console.log('Ya no hace falta copiar ids: se eligen en Configuración → Samsara → Alertas y cámaras (se actualiza cada hora).');
}

/** Datos de ejemplo. Se puede ejecutar varias veces: no duplica estaciones, unidades, áreas ni usuarios. */
function seedDemo() {
  soloEditor_();
  const correo = getSetting_('ADMIN_EMAIL', true);
  const min = (n) => new Date(Date.now() + n * 60000);
  const h = (n) => min(n * 60);

  const estacion = (nombre, desc) => DB.table('estaciones').where((e) => e.nombre === nombre)[0] ||
    DB.table('estaciones').insert({ nombre: nombre, descripcion: desc, activa: true });
  const e1 = estacion('Estación 1 - Norte', 'Rutas norte');
  const e2 = estacion('Estación 2 - Bajío', 'Rutas Bajío/Occidente');

  const unidades = DB.table('unidades').all();
  [['T-101', e1.id, 'Operador Demo 1'], ['T-205', e1.id, 'Operador Demo 2'], ['T-310', e2.id, 'Operador Demo 3'], ['T-412', e2.id, 'Operador Demo 4']]
    .filter((u) => !unidades.some((x) => x.economico === u[0]))
    .forEach((u) => DB.table('unidades').insert({ economico: u[0], estacion_id: u[1], operador: u[2], activo: true }));

  // En pruebas, todas las áreas apuntan a tu correo para que veas los tickets.
  const areas = DB.table('areas').all();
  ['Protección Patrimonial', 'Jefe de Monitoreo', 'Operaciones', 'Mantenimiento', 'Jurídico', 'Capital Humano']
    .filter((a) => !areas.some((x) => x.nombre === a))
    .forEach((a) => DB.table('areas').insert({ nombre: a, emails: correo }));

  // Usuarios de prueba (contraseña temporal en el registro de ejecución)
  const sistema = { rol: 'Admin', id: '' };
  [['mon1', 'Monitorista Demo 1', 'Monitorista', 'matutino', e1.id], ['mon2', 'Monitorista Demo 2', 'Monitorista', 'matutino', e2.id],
   ['mon3', 'Monitorista Demo 3', 'Monitorista', 'vespertino', e1.id], ['sup1', 'Supervisor Demo', 'Supervisor', '', '']]
    .filter((u) => !AuthService.buscarPorUsuario(u[0]))
    .forEach((u) => {
      const r = AuthService.guardarUsuario({ usuario: u[0], nombre: u[1], rol: u[2], turno_base: u[3], estacion_id: u[4] }, sistema);
      console.log('Usuario de prueba → ' + u[0] + ' (' + u[2] + ')   contraseña temporal: ' + r.password_temporal);
    });

  if (!DB.table('alarmas').where((a) => a.origen === 'demo' && a.estatus === 'nueva').length) {
    const base = { origen: 'demo', estatus: 'nueva' };
    DB.table('alarmas').insertMany([
      Object.assign({}, base, { unidad_id: 'T-101', estacion_id: e1.id, operador: 'Operador Demo 1', categoria: 'Botón de pánico', tipo_evento: 'Botón de pánico', severidad: 'critica', lat: 25.6866, lng: -100.3161, recibida_en: min(-3) }),
      Object.assign({}, base, { unidad_id: 'T-205', estacion_id: e1.id, operador: 'Operador Demo 2', categoria: 'Conducta del operador', tipo_evento: 'Uso de celular', severidad: 'alta', lat: 25.75, lng: -100.29, recibida_en: min(-12) }),
      Object.assign({}, base, { unidad_id: 'T-310', estacion_id: e2.id, operador: 'Operador Demo 3', categoria: 'Cámara obstruida', tipo_evento: 'Cámara obstruida', severidad: 'alta', lat: 20.6597, lng: -103.3496, recibida_en: min(-7) }),
      Object.assign({}, base, { unidad_id: 'T-412', estacion_id: e2.id, operador: 'Operador Demo 4', categoria: 'Conducta del operador', tipo_evento: 'Conducción agresiva', severidad: 'media', lat: 21.1619, lng: -101.6860, recibida_en: min(-25) }),
      Object.assign({}, base, { unidad_id: 'T-999', estacion_id: '', categoria: 'Falla GPS / Desconexión', tipo_evento: 'Desconexión de batería', severidad: 'alta', recibida_en: min(-5) }),
    ]);
  }
  if (!DB.table('viajes').all().length) {
    DB.table('viajes').insert({ unidad_id: 'T-101', cliente: 'Cliente A', fecha_cita: h(5), eta_proyectado: h(3), estatus: 'en_transito' });
    DB.table('viajes').insert({ unidad_id: 'T-310', cliente: 'Cliente B', fecha_cita: h(2), eta_proyectado: h(1.5), estatus: 'en_transito' });
    DB.table('viajes').insert({ unidad_id: 'T-412', cliente: 'Cliente C', fecha_cita: h(1), eta_proyectado: h(2), estatus: 'en_transito' });
  }
  console.log('Datos demo listos. Las áreas envían a ' + correo + ' (cámbialo en la hoja "areas").');
}

/** Inserta un evento simulado con la misma forma que devuelve /safety-events/stream. */
function simularAlarmaSamsara() {
  soloEditor_();
  const ev = {
    id: 'sim-' + Date.now(), createdAtTime: new Date().toISOString(),
    asset: { id: 'sim-asset', name: 'T-205' }, driver: { id: 'd1', name: 'Operador Demo 2' },
    location: { latitude: 25.70, longitude: -100.30, address: { formattedAddress: 'Carretera Monterrey-Saltillo km 12' } },
    behaviorLabels: [{ label: 'MobileUsage', source: 'automated' }],
  };
  const alarma = IngestaSamsaraService.asignarEstacion_(IngestaSamsaraService.mapearEventoSeguridad(ev), DB.table('unidades').all());
  DB.table('alarmas').insert(alarma);
  console.log('Alarma simulada: ' + JSON.stringify(alarma));
}

function limpiarAlarmasYTickets() {
  soloEditor_();
  const ss = SpreadsheetApp.openById(getSetting_('SPREADSHEET_ID', true));
  ['alarmas', 'tickets', 'seguimientos'].forEach((n) => {
    const sh = ss.getSheetByName(n);
    if (sh && sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
  });
  console.log('Alarmas, tickets y seguimientos borrados.');
}
