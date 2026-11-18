/**
 * Tablero 3: Unidades detenidas >= 48 h (flota inactiva).
 * La causa es obligatoria y debe pertenecer al catálogo de CONFIG.INACTIVAS.CAUSAS.
 */
const InactivasService = {
  listar: function () {
    const ahora = Date.now();
    return DB.table('inactivas').where((r) => !r.cerrada).map((r) => {
      const horas = Math.floor((ahora - new Date(r.inicio_paro).getTime()) / 3600000);
      return Object.assign({}, r, { horas_inactiva: horas, sin_clasificar: !r.causa });
    }).filter((r) => r.horas_inactiva >= CONFIG.INACTIVAS.HORAS_MINIMAS)
      .sort((a, b) => b.horas_inactiva - a.horas_inactiva);
  },

  clasificar: function (id, causa, responsable, liberacionEstimada) {
    if (CONFIG.INACTIVAS.CAUSAS.indexOf(causa) === -1) {
      throw new Error('Causa inválida. Usa una de: ' + CONFIG.INACTIVAS.CAUSAS.join(', '));
    }
    if (!responsable) throw new Error('El responsable es obligatorio.');
    return DB.table('inactivas').update(id, {
      causa: causa, responsable: responsable,
      liberacion_estimada: liberacionEstimada ? new Date(liberacionEstimada) : null,
    });
  },
};
