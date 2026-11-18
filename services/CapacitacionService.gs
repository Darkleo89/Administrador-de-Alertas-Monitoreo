/**
 * Tablero 4: Avance de capacitación y telemetría Samsara.
 * Ciclo semanal: los contadores reinician cada lunes a las 00:00.
 */
const CapacitacionService = {
  /** Lunes 00:00 de la semana de la fecha dada. */
  inicioDeSemana: function (fecha) {
    const d = new Date(fecha || new Date());
    const dia = (d.getDay() + 6) % 7; // lunes = 0
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - dia);
    return d;
  },

  listarSemanaActual: function () {
    const inicio = this.inicioDeSemana().getTime();
    return DB.table('capacitaciones').where((c) => new Date(c.semana_inicio).getTime() === inicio)
      .sort((a, b) => (a.safety_score || 0) - (b.safety_score || 0));
  },

  /** Sincroniza con Samsara. Programado por trigger (ver Setup.gs). */
  sincronizarSamsara: function () {
    const operadores = SamsaraClient.obtenerResumenOperadores();
    const semana = this.inicioDeSemana();
    const repo = DB.table('capacitaciones');
    const existentes = repo.where((c) => new Date(c.semana_inicio).getTime() === semana.getTime());
    operadores.forEach((op) => {
      const datos = {
        operador: op.nombre, semana_inicio: semana,
        modulos_completados_pct: op.modulosPct, safety_score: op.safetyScore,
        sincronizado_en: new Date(),
      };
      const previo = existentes.find((e) => e.operador === op.nombre);
      if (previo) repo.update(previo.id, datos);
      else repo.insert(Object.assign({ estatus_revision: 'pendiente' }, datos));
    });
    return operadores.length;
  },
};
