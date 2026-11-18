/**
 * Desempeño por monitorista (KPIs del Caso de Negocio + asistencia por turno):
 *  - Tiempo en tomar la alarma (recibida -> tomada)
 *  - Tiempo de notificación al área (recibida -> ticket enviado). Meta <= CONFIG.SLA.TICKET_META_MIN
 *  - % tickets en meta, % primer estatus dentro de SLA (30–40 min)
 *  - Escalamientos, descartes, errores de envío, tiempo hasta el cierre
 *  - Turnos trabajados, horas en turno, alarmas por hora, retardos
 * filtroTurno: 'matutino' | 'vespertino' | 'nocturno' | '' (todas las horas)
 */
const DesempenoService = {
  /** bandeja: monitoreo | seguridad_vial (Seguridad Vial: toda la flota, sin turnos ni SLA). */
  resumen: function (desde, hasta, estacionId, filtroTurno, bandeja) {
    const sv = bandeja === 'seguridad_vial';
    const d = new Date(desde).getTime();
    const h = new Date(hasta).getTime();
    const enRango = (f) => { const t = new Date(f).getTime(); return t >= d && t <= h; };
    const enTurno = (f) => !filtroTurno || TurnoService.turnoDeHora(new Date(f)).id === filtroTurno;

    const alarmas = DB.table('alarmas').where((a) => a.recibida_en && enRango(a.recibida_en) && enTurno(a.recibida_en) &&
      (!bandeja || bandejaDe_(a) === bandeja) && (sv || !estacionId || esDeEstacion_(a, estacionId)));
    const ticketsPorId = {};
    DB.table('tickets').all().forEach((t) => { ticketsPorId[t.id] = t; });
    const usuarios = {};
    DB.table('usuarios').all().forEach((u) => { usuarios[String(u.usuario).toLowerCase()] = u; });
    const turnos = sv ? [] : DB.table('turnos').where((t) => t.inicio_en && enRango(t.inicio_en) &&
      (!filtroTurno || t.turno === filtroTurno) && (!estacionId || String(t.estacion_id) === String(estacionId)));

    const grupos = {};
    const grupo = (k) => (grupos[k] = grupos[k] || { alarmas: [], turnos: [] });
    alarmas.filter((a) => a.asignado_a).forEach((a) => grupo(String(a.asignado_a).toLowerCase()).alarmas.push(a));
    turnos.forEach((t) => grupo(String(t.usuario).toLowerCase()).turnos.push(t));

    const prom = (arr) => (arr.length ? Math.round((arr.reduce((s, x) => s + x, 0) / arr.length) * 10) / 10 : null);
    const pct = (n, total) => (total ? Math.round((n / total) * 100) : null);

    const filas = Object.keys(grupos).map((login) => {
      const lista = grupos[login].alarmas;
      const sus = grupos[login].turnos;
      const tickets = lista.map((a) => ticketsPorId[a.ticket_id]).filter(Boolean);
      const enviados = tickets.filter((t) => t.enviado_en);
      const minTomar = lista.map((a) => minutosEntre_(a.recibida_en, a.tomada_en)).filter((x) => x !== null && x >= 0);
      const minTicket = enviados.map((t) => {
        const a = lista.find((x) => x.id === t.alarma_id);
        return minutosEntre_(a.recibida_en, t.enviado_en);
      }).filter((x) => x !== null && x >= 0);
      const primerElegibles = tickets.filter((t) => t.primer_estatus_en || Date.now() > new Date(t.sla_primer_estatus_en).getTime());
      const primerEnSla = primerElegibles.filter((t) => t.primer_estatus_en && new Date(t.primer_estatus_en) <= new Date(t.sla_primer_estatus_en));
      const cerradas = lista.filter((a) => a.cerrada_en);
      const horas = sus.reduce((s, t) => s + Math.max(0, (new Date(t.fin_en || Date.now()) - new Date(t.inicio_en)) / 3600000), 0);
      const u = usuarios[login] || {};
      return {
        login: login, nombre: u.nombre || login, turno_base: u.turno_base || '',
        turnos: sus.length, horas_turno: Math.round(horas * 10) / 10,
        retardos: sus.filter((t) => Number(t.retardo_min || 0) > CONFIG.TURNO_TOLERANCIA_RETARDO_MIN).length,
        atendidas: lista.length,
        alarmas_por_hora: horas >= 0.25 ? Math.round((lista.length / horas) * 10) / 10 : null, // con <15 min la tasa no es representativa
        abiertas: lista.filter((a) => a.estatus === 'en_atencion' || a.estatus === 'seguimiento').length,
        prom_min_tomar: prom(minTomar),
        tickets: tickets.length,
        tickets_error_envio: tickets.filter((t) => t.envio_error).length,
        prom_min_ticket: prom(minTicket),
        pct_ticket_en_meta: pct(minTicket.filter((m) => m <= CONFIG.SLA.TICKET_META_MIN).length, minTicket.length),
        // Elegibles: ya tienen primer estatus o su plazo ya venció (los que aún están en tiempo no cuentan).
        pct_primer_estatus_sla: pct(primerEnSla.length, primerElegibles.length),
        escalados: tickets.filter((t) => t.escalado_en).length,
        descartadas: lista.filter((a) => a.estatus === 'descartada').length,
        prom_min_cierre: prom(cerradas.map((a) => minutosEntre_(a.recibida_en, a.cerrada_en)).filter((x) => x !== null && x >= 0)),
        // Tiempo de revisión: de tomarla a resolverla (reporte enviado o cerrada sin reporte)
        prom_min_revision: prom(lista.map((a) => {
          const t = ticketsPorId[a.ticket_id];
          return minutosEntre_(a.tomada_en, (t && t.creado_en) || a.cerrada_en);
        }).filter((x) => x !== null && x >= 0)),
      };
    }).sort((a, b) => b.atendidas - a.atendidas);

    const sinTomar = alarmas.filter((a) => a.estatus === 'nueva');
    return {
      desde: new Date(d), hasta: new Date(h), meta_ticket_min: CONFIG.SLA.TICKET_META_MIN, turnos_catalogo: CONFIG.TURNOS,
      bandeja: bandeja || '',
      totales: {
        recibidas: alarmas.length,
        sin_tomar: sinTomar.length,
        mas_antigua_sin_tomar_min: sinTomar.length ? Math.round(Math.max.apply(null, sinTomar.map((a) => minutosEntre_(a.recibida_en, new Date())))) : null,
        tickets: filas.reduce((s, f) => s + f.tickets, 0),
        descartadas: filas.reduce((s, f) => s + f.descartadas, 0),
        turnos: turnos.length,
      },
      monitoristas: filas,
    };
  },
};
