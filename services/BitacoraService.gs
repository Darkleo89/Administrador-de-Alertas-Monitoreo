/**
 * Bitácora general: todo lo que se registra con bitacora_() (alarmas, tickets, turnos, evidencias,
 * accesos y cambios de administración), con filtros para auditoría.
 */
const BitacoraService = {
  NOMBRES: {
    tomar: 'Tomó alarma', descartar: 'Descartó alarma', registrar_manual: 'Registró alarma manual', reasignar: 'Reasignó alarma',
    nota: 'Nota', enviar_ticket: 'Envió ticket', reenviar_ticket: 'Reenvió ticket', primer_estatus: 'Primer estatus',
    escalar: 'Escaló ticket', cerrar: 'Cerró ticket', evidencia: 'Subió evidencia', evidencia_eliminada: 'Quitó evidencia',
    devuelta_por_entrega: 'Alarma devuelta en relevo', inicio_turno: 'Inició turno', entrega_turno: 'Entregó turno',
    login: 'Inició sesión', logout: 'Cerró sesión', login_bloqueado: 'Usuario bloqueado por intentos',
    usuario_alta: 'Alta de usuario', usuario_cambio: 'Cambio de usuario', usuario_password: 'Restableció contraseña',
    area_alta: 'Alta de área', area_cambio: 'Cambio de área', estacion: 'Cambio de estación', parametro: 'Cambio de parámetro',
    catalogo: 'Catálogo', tipo_incidencia: 'Tipo de incidencia', circuito: 'Circuito', lista: 'Lista de distribución',
    etiqueta: 'Etiqueta de Samsara', por_validar: 'Datos nuevos por validar',
  },

  /** filtros = { desde, hasta, usuario, accion, texto } */
  buscar: function (filtros) {
    const d = new Date(filtros.desde).getTime();
    const h = new Date(filtros.hasta).getTime();
    const u = String(filtros.usuario || '').trim().toLowerCase();
    const q = String(filtros.texto || '').trim().toLowerCase();
    const alarmas = {};
    DB.table('alarmas').all().forEach((a) => { alarmas[a.id] = a; });
    const folios = {};
    DB.table('tickets').all().forEach((t) => { folios[t.id] = t.folio; });

    const filas = DB.table('seguimientos').where((s) => {
      const f = new Date(s.creado_en).getTime();
      if (f < d || f > h) return false;
      if (u && String(s.usuario || '').toLowerCase() !== u) return false;
      if (filtros.accion && s.accion !== filtros.accion) return false;
      return true;
    }).map((s) => {
      const a = alarmas[s.alarma_id] || {};
      return {
        creado_en: s.creado_en, usuario: s.usuario, accion: s.accion, accion_nombre: this.NOMBRES[s.accion] || s.accion,
        nota: s.nota || '', unidad: a.unidad_id || '', folio: folios[s.ticket_id] || '',
      };
    }).filter((r) => !q || [r.usuario, r.accion_nombre, r.nota, r.unidad, r.folio].join(' ').toLowerCase().indexOf(q) !== -1)
      .sort((x, y) => new Date(y.creado_en) - new Date(x.creado_en));

    return {
      total: filas.length, filas: filas.slice(0, 2000),
      acciones: Object.keys(this.NOMBRES).map((k) => ({ v: k, t: this.NOMBRES[k] })),
      usuarios: DB.table('usuarios').all().map((x) => ({ v: x.usuario, t: x.nombre + ' (' + x.usuario + ')' })),
    };
  },
};
