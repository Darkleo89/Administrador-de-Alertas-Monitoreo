/**
 * Tablero 2: Unidades en tránsito y cumplimiento de citas (ETA).
 * margen = fecha_cita - eta_proyectado (minutos)
 */
const EtaService = {
  semaforo: function (margenMin) {
    if (margenMin < 0) return 'rojo';                              // retraso proyectado
    if (margenMin > CONFIG.ETA.VERDE_MARGEN_MIN) return 'verde';   // > 1 h
    return 'amarillo';                                             // 0–60 min (regla 45–60 pendiente de confirmar)
  },

  listarEnTransito: function () {
    return DB.table('viajes').where((v) => v.estatus === 'en_transito').map((v) => {
      const margen = Math.round((new Date(v.fecha_cita) - new Date(v.eta_proyectado)) / 60000);
      return Object.assign({}, v, { margen_min: margen, semaforo: EtaService.semaforo(margen) });
    }).sort((a, b) => a.margen_min - b.margen_min);
  },
};
