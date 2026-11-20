/**
 * Punto de entrada de la web app y capa "API".
 *
 * La app es pública (cualquiera con la URL ve la pantalla de login) y usa login propio.
 * Por eso: TODAS las funciones globales que no son api_* / doGet / include terminan en "_"
 * (google.script.run no puede llamarlas), y cada api_* recibe el token de sesión primero.
 * Cada api_* equivale a un endpoint REST futuro (tabla en docs/arquitectura.md).
 */
function doGet() {
  return HtmlService.createTemplateFromFile('ui/Index')
    .evaluate()
    .setTitle('Monitoreo de Flota · GAL')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Incluye parciales HTML (CSS/JS) dentro de las plantillas. */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/**
 * Devuelve el JavaScript de un parcial (lo que está entre <script> y </script>) codificado en hexadecimal.
 * Apps Script preprocesa el JS que va "en crudo" en la página y llega a cortarlo (confunde //, /* y otros
 * patrones con comentarios), dejando la app en blanco. En hexadecimal solo hay 0-9a-f: no hay nada que cortar.
 * Index.html lo decodifica y lo ejecuta con un <script> creado en el navegador.
 */
function incluirScript_(name) {
  const html = HtmlService.createHtmlOutputFromFile(name).getContent();
  const ini = html.indexOf('>', html.indexOf('<script')) + 1;
  const fin = html.lastIndexOf('</script>');
  const codigo = html.slice(ini, fin);
  return Utilities.newBlob(codigo).getBytes().map((b) => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

// ---------- Sesión y autorización ----------
/**
 * Valida el token y arma el contexto del usuario:
 *   { id, login, nombre, rol, email, estacion_id, turno_id }
 * La estación viene del turno activo (la elige al iniciar turno).
 */
function ctx_(token, roles, opciones) {
  opciones = opciones || {};
  ConfigService.aplicar();   // parámetros editados en Administración
  const v = AuthService.validarToken(token);
  const u = v.usuario;
  if (roles && u.rol !== 'Admin' && roles.indexOf(u.rol) === -1) {
    throw new Error('Tu rol (' + u.rol + ') no tiene permiso para esta acción.');
  }
  if (u.debe_cambiar_password === true && !opciones.permitirCambioPendiente) {
    throw new Error('PASSWORD: Debes cambiar tu contraseña temporal.');
  }
  const turno = TurnoService.activoDe(u.id);
  if (opciones.requiereTurno && !turno && CONFIG.ROLES_CON_TURNO.indexOf(u.rol) !== -1) {
    throw new Error('TURNO: Inicia tu turno para operar la consola.');
  }
  // Actualiza "última actividad" como máximo cada 2 min (menos escrituras en la hoja).
  if (Date.now() - new Date(v.sesion.ultima_actividad).getTime() > 120000) AuthService.tocarSesion(v.sesion.id);
  return {
    id: u.id, login: u.usuario, nombre: u.nombre || u.usuario, rol: u.rol, email: u.email || '', area: u.area || '',
    estacion_id: turno ? turno.estacion_id : '', turno_id: turno ? turno.id : '',
  };
}

/** google.script.run no acepta Date: se serializa todo a JSON plano. */
function out_(data) {
  return JSON.parse(JSON.stringify(data));
}

const ROLES_CONSOLA = ['Monitorista', 'Supervisor', 'Seguridad Vial'];
const ROLES_SEGUIMIENTO = ['Monitorista', 'Supervisor', 'Mantenimiento', 'Operaciones', 'Jurídico', 'Seguridad Vial'];
const OPC_TURNO = { requiereTurno: true };

// ---------- API: autenticación ----------
function api_login(usuario, password) {
  ConfigService.aplicar();
  return out_(AuthService.login(usuario, password));
}
function api_logout(token) {
  AuthService.logout(token);
  return true;
}
function api_cambiarPassword(token, actual, nueva) {
  const u = ctx_(token, null, { permitirCambioPendiente: true });
  return out_(AuthService.cambiarPassword(u.id, actual, nueva));
}
/** Datos de arranque de la app: usuario, turno activo, turno programado y estaciones. */
function api_sesion(token) {
  const u = ctx_(token, null, { permitirCambioPendiente: true });
  const row = DB.table('usuarios').find(u.id);
  const turno = TurnoService.activoDe(u.id);
  return out_({
    usuario: { login: u.login, nombre: u.nombre, rol: u.rol, estacion_sugerida: row.estacion_id || '' },
    debe_cambiar_password: row.debe_cambiar_password === true,
    requiere_turno: CONFIG.ROLES_CON_TURNO.indexOf(u.rol) !== -1,
    turno: turno, programado: TurnoService.turnoDeHora(new Date()),
    estaciones: DB.table('estaciones').where((e) => e.activa !== false),
  });
}

// ---------- API: turnos ----------
function api_iniciarTurno(token, estacionId) {
  const u = ctx_(token);
  return out_(TurnoService.iniciar(u, estacionId));
}
function api_resumenEntrega(token) {
  const u = ctx_(token);
  return out_({
    alarmas: DB.table('alarmas').where((a) => a.estatus === 'en_atencion' && a.asignado_a === u.login).length,
    tickets: DB.table('tickets').where((t) => t.monitorista === u.login && t.estatus !== 'cerrado').length,
  });
}
function api_entregarTurno(token, nota) {
  const u = ctx_(token);
  if (!u.turno_id) throw new Error('No tienes turno activo.');
  const r = TurnoService.entregar(u.turno_id, nota, u.login);
  AuthService.logout(token);
  return out_(r);
}
function api_panelTurnos(token) {
  ctx_(token, ['Supervisor']);
  return out_(TurnoService.panel());
}
function api_forzarEntrega(token, turnoId, nota) {
  const u = ctx_(token, ['Supervisor']);
  return out_(TurnoService.entregar(turnoId, '[Supervisión] ' + (nota || ''), u.login));
}

// ---------- API: administración ----------
function api_usuarios(token) {
  ctx_(token, ['Supervisor']);
  const conteo = {};
  DB.table('unidades').where((u) => u.activo !== false && u.estacion_id).forEach((u) => { conteo[u.estacion_id] = (conteo[u.estacion_id] || 0) + 1; });
  return out_({
    usuarios: AuthService.listarUsuarios(),
    estaciones: DB.table('estaciones').all().map((e) => Object.assign({}, e, { unidades: conteo[e.id] || 0 })),
    roles: CONFIG.ROLES, turnos: CONFIG.TURNOS, bandejas: CONFIG.BANDEJAS,
    sync: { ultima: Parametros.get('estaciones_ultima_sync'), error: Parametros.get('estaciones_ultimo_error'), tag: CONFIG.SAMSARA.TAG_PADRE_ESTACIONES },
  });
}
/** Botón "Sincronizar desde Samsara": estaciones (Monitoreo) + circuitos (GRUPO GAL), conductores y remolques. */
function api_sincronizarEstaciones(token) {
  ctx_(token, ['Supervisor']);
  try { Migraciones.aplicarPendientes(); } catch (e) { console.error(e); }
  let estaciones;
  try {
    estaciones = CatalogoSamsaraService.sincronizar();
    Parametros.set('estaciones_ultimo_error', '');
  } catch (e) {
    Parametros.set('estaciones_ultimo_error', new Date().toISOString() + ' ' + e.message);
    throw e;
  }
  let catalogos;
  try {
    catalogos = SincronizacionCatalogos.ejecutar();
    Parametros.set('catalogos_ultimo_error', catalogos.errores.join(' | '));
  } catch (e) {
    Parametros.set('catalogos_ultimo_error', new Date().toISOString() + ' ' + e.message);
    catalogos = { error: e.message };
  }
  let alertas;
  try { alertas = AlertasSamsaraService.sincronizar(); } catch (e) { alertas = { error: e.message }; }
  return out_(Object.assign({}, estaciones, { catalogos: catalogos, alertas: alertas }));
}
function api_guardarUsuario(token, datos) {
  return out_(AuthService.guardarUsuario(datos, ctx_(token, ['Supervisor'])));
}
function api_restablecerPassword(token, usuarioId) {
  return out_(AuthService.restablecerPassword(usuarioId, ctx_(token, ['Supervisor'])));
}
// ---------- API: Administración de catálogos ----------
/** Datos base de la pestaña: conteos por catálogo y listas para los selectores. */
/** Inicio de Configuración: lo que requiere atención por grupo (solo lectura). */
function api_configResumen(token) {
  return out_(ConfiguracionService.resumen(ctx_(token, ['Supervisor'])));
}
function api_adminCatalogos(token) {
  const u = ctx_(token, ['Supervisor']);
  return out_({
    resumen: CatalogoAdminService.resumen(), es_admin: u.rol === 'Admin',
    circuitos: CatalogoService.circuitos(false).map((c) => ({ id: c.id, nombre: c.nombre, activo: c.activo !== false })),
    severidades: CatalogoAdminService.SEVERIDADES, usos: CatalogoAdminService.USOS_ETIQUETA,
  });
}
function api_catalogoListar(token, tipo) {
  ctx_(token, ['Supervisor']);
  return out_(CatalogoAdminService.listarSimple(tipo));
}
function api_catalogoGuardar(token, datos) {
  return out_(CatalogoAdminService.guardarSimple(datos, ctx_(token, ['Supervisor'])));
}
function api_catalogoUnir(token, origenId, destinoId) {
  return out_(CatalogoAdminService.unir(origenId, destinoId, ctx_(token, ['Supervisor'])));
}
function api_tiposAdmin(token) {
  ctx_(token, ['Admin']);
  return out_(CatalogoAdminService.listarTipos());
}
function api_tipoGuardar(token, datos) {
  return out_(CatalogoAdminService.guardarTipo(datos, ctx_(token, ['Admin'])));
}
function api_circuitosAdmin(token) {
  ctx_(token, ['Admin']);
  return out_(CatalogoAdminService.listarCircuitos());
}
function api_circuitoGuardar(token, datos) {
  return out_(CatalogoAdminService.guardarCircuito(datos, ctx_(token, ['Admin'])));
}
/** Listas de distribución + matriz de cobertura (circuitos × tipos). */
function api_listasAdmin(token) {
  ctx_(token, ['Admin']);
  return out_({ listas: CatalogoAdminService.listarListas(), cobertura: CatalogoService.cobertura(), tipos: CatalogoAdminService.listarTipos() });
}
function api_listaGuardar(token, datos) {
  return out_(CatalogoAdminService.guardarLista(datos, ctx_(token, ['Admin'])));
}
function api_coberturaAsignar(token, circuitoId, tipoId, listaId) {
  return out_(CatalogoAdminService.asignarCobertura(circuitoId, tipoId, listaId, ctx_(token, ['Admin'])));
}
function api_etiquetasAdmin(token) {
  ctx_(token, ['Admin']);
  return out_(CatalogoAdminService.listarEtiquetas());
}
function api_etiquetaGuardar(token, datos) {
  return out_(CatalogoAdminService.guardarEtiqueta(datos, ctx_(token, ['Admin'])));
}
/** Alertas configuradas en Samsara: cuáles se vigilan, severidad y tipo sugerido. */
function api_alertasSamsaraAdmin(token) {
  ctx_(token, ['Admin']);
  return out_({ alertas: AlertasSamsaraService.listar(), tipos: CatalogoAdminService.listarTipos(),
    estaciones: DB.table('estaciones').where((e) => e.activa !== false).map((e) => ({ id: e.id, nombre: e.nombre })),
    lectura: AlertasSamsaraService.ultimaLectura(), ultima_sync: Parametros.get('alertas_samsara_sync') || '' });
}
function api_alertaSamsaraGuardar(token, datos) {
  return out_(AlertasSamsaraService.guardar(datos, ctx_(token, ['Admin'])));
}
/** Agrega una alerta que Samsara no lista por API (p. ej. paradas con "Asset stops moving"), con su enlace. */
function api_alertaSamsaraAgregar(token, datos) {
  return out_(AlertasSamsaraService.agregarPorEnlace(datos || {}, ctx_(token, ['Admin'])));
}
/** Diagnóstico de la API de alertas de Samsara (solo lectura, solo Admin). */
function api_alertasSamsaraDiagnostico(token, texto, id) {
  ctx_(token, ['Admin']);
  return out_(SamsaraClient.diagnosticoAlertas(texto, id));
}
/** Vuelve a leer de Samsara la lista de alertas configuradas (solo lectura). */
function api_alertasSamsaraSincronizar(token) {
  const u = ctx_(token, ['Admin']);
  const r = AlertasSamsaraService.sincronizar();
  bitacora_('', '', u.login, 'alerta_samsara', 'Lista actualizada desde Samsara: ' + r.total + ' alertas, ' + r.nuevas + ' nuevas, ' + r.retiradas + ' ya no existen.');
  return out_(r);
}

// ---------- API: Administración (áreas, parámetros, bitácora) ----------
function api_areas(token) {
  ctx_(token, ['Supervisor']);
  return out_(AreaService.listar());
}
function api_guardarArea(token, datos) {
  return out_(AreaService.guardar(datos, ctx_(token, ['Supervisor'])));
}
function api_parametros(token) {
  ctx_(token, ['Admin']);
  return out_(ConfigService.listar());
}
function api_guardarParametro(token, clave, valor) {
  return out_(ConfigService.guardar(clave, valor, ctx_(token, ['Admin'])));
}
function api_restablecerParametro(token, clave) {
  return out_(ConfigService.restablecer(clave, ctx_(token, ['Admin'])));
}
function api_bitacora(token, filtros) {
  ctx_(token, ['Supervisor']);
  return out_(BitacoraService.buscar(filtros || {}));
}

/** Grupo de apoyo de una estación (también las de Samsara): las del mismo grupo se ven y se ayudan. */
function api_estacionGrupo(token, estacionId, grupo) {
  const admin = ctx_(token, ['Admin']);
  const e = DB.table('estaciones').find(estacionId);
  if (!e) throw new Error('Estación no encontrada.');
  const g = String(grupo || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const r = DB.table('estaciones').update(e.id, { grupo: g });
  olvidarGruposEstacion_();
  bitacora_('', '', admin.login, 'estacion', e.nombre + ': ' + (g ? 'grupo de apoyo "' + g + '"' : 'sin grupo de apoyo'));
  return out_(r);
}
function api_guardarEstacion(token, datos) {
  const admin = ctx_(token, ['Admin']);
  if (!datos.nombre) throw new Error('El nombre es obligatorio.');
  if (datos.id) {
    const actual = DB.table('estaciones').find(datos.id);
    if (actual && actual.origen === 'samsara') throw new Error('Esta estación viene de Samsara: cámbiala allá (etiqueta ' + CONFIG.SAMSARA.TAG_PADRE_ESTACIONES + ').');
  }
  const campos = { nombre: datos.nombre, descripcion: datos.descripcion || '', activa: datos.activa !== false, origen: 'manual' };
  bitacora_('', '', admin.login, 'estacion', (datos.id ? 'Cambio: ' : 'Alta: ') + campos.nombre + (campos.activa ? '' : ' (inactiva)'));
  olvidarGruposEstacion_();
  return out_(datos.id ? DB.table('estaciones').update(datos.id, campos) : DB.table('estaciones').insert(campos));
}

// ---------- API: consola de alarmas ----------
function api_consola(token, estacionId, bandeja) {
  return out_(AlarmaService.consola(ctx_(token, ROLES_CONSOLA, OPC_TURNO), estacionId, bandeja));
}
function api_tomarAlarma(token, id) {
  return out_(AlarmaService.tomar(id, ctx_(token, ROLES_CONSOLA, OPC_TURNO)));
}
function api_descartarAlarma(token, id, resultado, nota) {
  return out_(AlarmaService.descartar(id, resultado, nota, ctx_(token, ROLES_CONSOLA, OPC_TURNO)));
}
function api_registrarAlarmaManual(token, datos) {
  return out_(AlarmaService.registrarManual(datos, ctx_(token, ROLES_CONSOLA, OPC_TURNO)));
}
function api_reasignarAlarma(token, id, login) {
  return out_(AlarmaService.reasignar(id, login, ctx_(token, ['Supervisor'])));
}
function api_nota(token, alarmaId, ticketId, nota) {
  return out_(AlarmaService.agregarNota(alarmaId, ticketId, nota, ctx_(token, ROLES_SEGUIMIENTO, OPC_TURNO)));
}
function api_historial(token, alarmaId) {
  ctx_(token, ROLES_SEGUIMIENTO);
  return out_(AlarmaService.historial(alarmaId));
}

// ---------- API: tickets ----------
/** Catálogos para el formulario del ticket (se carga una vez al abrirlo). */
function api_catalogoTicket(token) {
  ctx_(token, ROLES_CONSOLA, OPC_TURNO);
  return out_(CatalogoService.datosTicket());
}
function api_enviarTicket(token, alarmaId, form) {
  return out_(TicketService.enviar(alarmaId, form, ctx_(token, ROLES_CONSOLA, OPC_TURNO)));
}
function api_reenviarTicket(token, ticketId) {
  return out_(TicketService.reenviar(ticketId, ctx_(token, ROLES_CONSOLA, OPC_TURNO)));
}
function api_primerEstatus(token, ticketId, nota) {
  return out_(TicketService.primerEstatus(ticketId, nota, ctx_(token, ROLES_CONSOLA, OPC_TURNO)));
}
function api_escalarTicket(token, ticketId, motivo) {
  const u = ctx_(token, ROLES_CONSOLA, OPC_TURNO);
  const tk = DB.table('tickets').find(ticketId);
  TicketService.verificarAcceso_(tk, u);
  if (bandejaDe_(tk) === 'seguridad_vial') throw new Error('Los reportes de Seguridad Vial no se escalan.');
  const r = TicketService.escalar(ticketId, motivo || 'Escalamiento manual', u.login);
  if (!r) throw new Error('El ticket ya fue escalado o está cerrado.');
  return out_(r);
}
function api_cerrarTicket(token, ticketId, conclusion) {
  return out_(TicketService.cerrar(ticketId, conclusion, ctx_(token, ROLES_CONSOLA, OPC_TURNO)));
}

// ---------- API: evidencias y reportes PDF ----------
function api_subirEvidencia(token, alarmaId, tipo, nombre, mime, base64) {
  const e = EvidenciaService.subir(alarmaId, tipo, nombre, mime, base64, ctx_(token, ROLES_CONSOLA, OPC_TURNO));
  return out_({ id: e.id, tipo: e.tipo, nombre: e.nombre });
}
/** PDF y video: se suben por partes (iniciar -> partes). REST: POST /api/alarmas/:id/anexos y PUT /api/anexos/:id/partes/:n */
function api_evidenciaIniciar(token, alarmaId, tipo, nombre, mime, tamano) {
  return out_(EvidenciaService.iniciarAnexo(alarmaId, tipo, nombre, mime, tamano, ctx_(token, ROLES_CONSOLA, OPC_TURNO)));
}
function api_evidenciaParte(token, evidenciaId, indice, base64) {
  return out_(EvidenciaService.subirParte(evidenciaId, indice, base64, ctx_(token, ROLES_CONSOLA, OPC_TURNO)));
}
function api_eliminarEvidencia(token, evidenciaId) {
  return out_(EvidenciaService.eliminar(evidenciaId, ctx_(token, ROLES_CONSOLA, OPC_TURNO)));
}
const ROLES_REPORTES = ['Monitorista', 'Supervisor', 'Mantenimiento', 'Operaciones', 'Jurídico', 'Capital Humano', 'Seguridad Vial'];
function api_reportes(token, desdeIso, hastaIso, estacionId, texto) {
  return out_(ReporteService.listar(ctx_(token, ROLES_REPORTES), desdeIso, hastaIso, estacionId, texto));
}
/** Datos del reporte descargable (Excel) del periodo: columnas + filas. El navegador arma el .xlsx. */
function api_reporteExportar(token, desdeIso, hastaIso, estacionId) {
  return out_(ReporteService.exportar(ctx_(token, ROLES_REPORTES), desdeIso, hastaIso, estacionId));
}
/** Devuelve el PDF del reporte en base64 para descargarlo en el navegador. */
function api_reportePdf(token, ticketId) {
  return out_(ReporteService.pdfParaDescarga(ticketId, ctx_(token, ROLES_REPORTES)));
}

// ---------- API: desempeño ----------
function api_desempeno(token, desdeIso, hastaIso, estacionId, turno, bandeja) {
  const u = ctx_(token, ['Supervisor']);
  const mias = bandejasDeUsuario_(u);
  const b = bandeja && mias.indexOf(bandeja) !== -1 ? bandeja : (mias.length === 1 ? mias[0] : 'monitoreo');
  const r = DesempenoService.resumen(desdeIso, hastaIso, estacionId, turno, b);
  r.bandejas = mias;
  return out_(r);
}
/** Cada monitorista puede ver su propio desempeño. */
function api_miDesempeno(token, desdeIso, hastaIso, turno) {
  const u = ctx_(token, ROLES_CONSOLA);
  const mias = bandejasDeUsuario_(u);
  const r = DesempenoService.resumen(desdeIso, hastaIso, null, turno, mias.length === 1 ? mias[0] : 'monitoreo');
  r.monitoristas = r.monitoristas.filter((m) => m.login === u.login);
  return out_(r);
}

// ---------- API: otros tableros ----------
function api_listarEta(token) {
  ctx_(token, ['Operaciones', 'Monitorista', 'Supervisor']);
  return out_(EtaService.listarEnTransito());
}
function api_listarInactivas(token) {
  ctx_(token, ['Operaciones', 'Mantenimiento', 'Jurídico', 'Supervisor']);
  return out_({ unidades: InactivasService.listar(), causas: CONFIG.INACTIVAS.CAUSAS });
}
function api_clasificarInactiva(token, id, causa, responsable, liberacion) {
  ctx_(token, ['Operaciones', 'Mantenimiento']);
  return out_(InactivasService.clasificar(id, causa, responsable, liberacion));
}
function api_listarCapacitacion(token) {
  ctx_(token, ['Capital Humano', 'Supervisor']);
  return out_(CapacitacionService.listarSemanaActual());
}
