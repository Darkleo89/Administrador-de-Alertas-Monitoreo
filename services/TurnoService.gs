/**
 * Turnos de 8 h (24/7): inicio de turno con elección de estación, entrega con nota de relevo.
 * Al entregar, las alarmas "en_atencion" del monitorista regresan a la cola de su estación.
 */
const TurnoService = {
  /** Turno programado que corresponde a una fecha/hora: { id, nombre, inicio: Date, fin: Date }. */
  turnoDeHora: function (fecha) {
    const d = new Date(fecha || new Date());
    const h = d.getHours();
    const t = CONFIG.TURNOS.find((x) => (x.inicio < x.fin ? h >= x.inicio && h < x.fin : h >= x.inicio || h < x.fin));
    const inicio = new Date(d); inicio.setMinutes(0, 0, 0); inicio.setHours(t.inicio);
    if (t.inicio > t.fin && h < t.fin) inicio.setDate(inicio.getDate() - 1); // nocturno después de medianoche
    const fin = new Date(inicio.getTime() + ((t.fin - t.inicio + 24) % 24) * 3600000);
    return { id: t.id, nombre: t.nombre, inicio: inicio, fin: fin };
  },

  activoDe: function (usuarioId) {
    return DB.table('turnos').where((t) => t.usuario_id === usuarioId && t.estatus === 'activo')[0] || null;
  },

  iniciar: function (usuario, estacionId) {
    if (!estacionId) throw new Error('Selecciona la estación que vas a cubrir.');
    const est = DB.table('estaciones').find(estacionId);
    if (!est || est.activa === false) throw new Error('Estación inválida.');
    if (this.activoDe(usuario.id)) throw new Error('Ya tienes un turno activo.');
    const ahora = new Date();
    let prog = this.turnoDeHora(ahora);
    const siguiente = this.turnoDeHora(new Date(ahora.getTime() + 30 * 60000));
    if (siguiente.id !== prog.id) prog = siguiente;  // entra hasta 30 min antes: cuenta para el turno que empieza
    const retardo = Math.max(0, Math.round((ahora - prog.inicio) / 60000));
    const t = DB.table('turnos').insert({
      usuario: usuario.login, usuario_id: usuario.id, turno: prog.id, estacion_id: estacionId,
      programado_inicio: prog.inicio, inicio_en: ahora, retardo_min: retardo, estatus: 'activo',
    });
    DB.table('usuarios').update(usuario.id, { estacion_id: estacionId }); // se sugiere la próxima vez
    bitacora_('', '', usuario.login, 'inicio_turno', prog.nombre + ' · ' + est.nombre + (retardo > CONFIG.TURNO_TOLERANCIA_RETARDO_MIN ? ' · retardo ' + retardo + ' min' : ''));
    return t;
  },

  /** Entrega de turno. quien = login de quien cierra (el propio usuario, un supervisor o 'sistema'). */
  entregar: function (turnoId, nota, quien) {
    if (!nota || String(nota).trim().length < 10) throw new Error('Escribe la nota de relevo (mínimo 10 caracteres).');
    const t = DB.table('turnos').find(turnoId);
    if (!t || t.estatus !== 'activo') throw new Error('El turno ya fue entregado.');

    const abiertas = DB.table('alarmas').where((a) => a.estatus === 'en_atencion' && a.asignado_a === t.usuario);
    abiertas.forEach((a) => {
      const r = DB.table('alarmas').updateIf(a.id, (x) => x.estatus === 'en_atencion' && x.asignado_a === t.usuario, {
        estatus: 'nueva', asignado_a: '', tomada_en: '', notas: [a.notas, 'Relevo (' + t.usuario + '): ' + nota].filter(Boolean).join('\n'),
      });
      if (r) bitacora_(a.id, '', quien, 'devuelta_por_entrega', nota);
    });
    const tickets = DB.table('tickets').where((x) => x.monitorista === t.usuario && x.estatus !== 'cerrado').length;
    const cerrado = DB.table('turnos').updateIf(turnoId, (x) => x.estatus === 'activo', {
      fin_en: new Date(), estatus: 'entregado', nota_entrega: nota, alarmas_devueltas: abiertas.length,
      tickets_abiertos: tickets, cerrado_por: quien,
    });
    bitacora_('', '', quien, 'entrega_turno', t.usuario + ': ' + nota + ' (' + abiertas.length + ' alarmas devueltas, ' + tickets + ' tickets abiertos)');
    return cerrado;
  },

  /** Supervisión: quién está en turno ahora y entregas recientes. */
  panel: function () {
    const usuarios = {};
    DB.table('usuarios').all().forEach((u) => { usuarios[u.id] = u; });
    const enAtencion = {};
    DB.table('alarmas').where((a) => a.estatus === 'en_atencion').forEach((a) => { enAtencion[a.asignado_a] = (enAtencion[a.asignado_a] || 0) + 1; });
    const todos = DB.table('turnos').all();
    const activos = todos.filter((t) => t.estatus === 'activo').map((t) => Object.assign({}, t, {
      nombre: (usuarios[t.usuario_id] || {}).nombre || t.usuario, alarmas_en_atencion: enAtencion[t.usuario] || 0,
    }));
    const hace24 = Date.now() - 24 * 3600000;
    const entregas = todos.filter((t) => t.estatus === 'entregado' && new Date(t.fin_en).getTime() > hace24)
      .map((t) => Object.assign({}, t, { nombre: (usuarios[t.usuario_id] || {}).nombre || t.usuario }))
      .sort((a, b) => new Date(b.fin_en) - new Date(a.fin_en));
    return { actual: this.turnoDeHora(new Date()), activos: activos, entregas: entregas };
  },

  /** Job: cierra turnos olvidados (más de CONFIG.TURNO_CIERRE_AUTOMATICO_H horas abiertos). */
  cerrarVencidos: function () {
    const limite = Date.now() - CONFIG.TURNO_CIERRE_AUTOMATICO_H * 3600000;
    const vencidos = DB.table('turnos').where((t) => t.estatus === 'activo' && new Date(t.inicio_en).getTime() < limite);
    vencidos.forEach((t) => this.entregar(t.id, 'Cierre automático: el turno superó ' + CONFIG.TURNO_CIERRE_AUTOMATICO_H + ' h sin entregarse.', 'sistema'));
    return vencidos.length;
  },
};
