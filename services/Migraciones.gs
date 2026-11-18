/**
 * Ajustes de datos que se aplican UNA sola vez en producción (como las migraciones de una base de datos).
 * Cada migración tiene un id; al aplicarse se guarda "migracion.<id>" en la tabla parametros.
 * Se ejecutan al inicio del ciclo de cada minuto y de las funciones de sincronización.
 */
const Migraciones = {
  LISTA: [
    {
      id: '2026-11-18-seguridad-vial',
      descripcion: 'Destino de alertas y eventos de cámara (Monitoreo / Seguridad Vial) y lista de correo de Seguridad Vial',
      aplicar: function () {
        const repo = DB.table('alertas_samsara');
        const conocidas = {};
        AlertasSamsaraService.ETIQUETAS_SEGURIDAD.forEach((e) => { conocidas[AlertasSamsaraService.PREFIJO_ETIQUETA + e[0]] = e[3]; });
        const cambios = {};
        let sv = 0;
        repo.all().forEach((a) => {
          if (AlertasSamsaraService.DESTINOS.indexOf(a.destino) !== -1) return;
          let destino = a.vigilar === true ? 'monitoreo' : 'ninguno';
          // Eventos de cámara que se vigilaban: conducta de manejo -> Seguridad Vial (pasajero y cámara obstruida siguen en Monitoreo)
          if (a.origen === 'seguridad' && a.vigilar === true) destino = conocidas[a.configuracion_id] || 'seguridad_vial';
          if (destino === 'seguridad_vial' || destino === 'ambos') sv++;
          cambios[a.id] = { destino: destino, vigilar: destino !== 'ninguno' };
        });
        if (Object.keys(cambios).length) repo.updateMany(cambios);
        CatalogoService.listaSeguridadVial();
        return Object.keys(cambios).length + ' alertas/eventos con destino (' + sv + ' a Seguridad Vial); lista de Seguridad Vial lista';
      },
    },
    {
      id: '2026-11-17-recuperar-eventos-url-larga',
      descripcion: 'Releer los eventos de cámara desde el último ciclo correcto (fallaron por "Longitud de URL" de las alertas)',
      aplicar: function () {
        const ultima = Parametros.get('samsara_ultima_sync');
        if (!ultima) return 'sin ciclo previo (se omite)';
        const desde = new Date(new Date(ultima).getTime() - 2 * 60000);
        if (Date.now() - desde.getTime() > 24 * 3600000) return 'último ciclo correcto hace más de 24 h (se omite)';
        Parametros.set('samsara_safety_cursor', '');
        Parametros.set('samsara_safety_inicio', desde.toISOString());
        return 'eventos de cámara se releen desde ' + desde.toISOString() + ' (no se duplican)';
      },
    },
    {
      id: '2026-11-17-etiquetas-cerdo-vivo',
      descripcion: 'Etiquetas reales de Samsara "Cerdo Vivo", "Cerdo Vivo Foraneo" y "Kulkaba" → circuito CERDO VIVO',
      aplicar: function () {
        const K = (s) => CatalogoService.clave(s);
        const circ = DB.table('circuitos').where((c) => K(c.nombre) === 'CERDO VIVO')[0];
        if (!circ) return 'sin circuito CERDO VIVO (se omite)';
        const repo = DB.table('etiquetas_samsara');
        const filas = repo.all();
        let n = 0;
        ['Cerdo Vivo', 'Cerdo Vivo Foraneo', 'Kulkaba'].forEach((nombre) => {
          const f = filas.find((x) => K(x.etiqueta) === K(nombre));
          if (f) repo.update(f.id, { uso: 'circuito', circuito_id: circ.id, activo: true });
          else repo.insert({ etiqueta: nombre, samsara_tag_id: '', uso: 'circuito', circuito_id: circ.id, activo: true });
          n++;
        });
        // Los nombres que se habían supuesto y no existen en Samsara se desactivan.
        filas.filter((x) => ['CERDO VIVO BAJIO', 'CERDO VIVO SURESTE'].indexOf(K(x.etiqueta)) !== -1 && !x.samsara_tag_id)
          .forEach((x) => repo.update(x.id, { activo: false }));
        return n + ' etiquetas asignadas';
      },
    },
  ],

  /** Aplica las pendientes. Devuelve los ids aplicados en esta ejecución. */
  aplicarPendientes: function () {
    const hechas = [];
    this.LISTA.forEach((m) => {
      const clave = 'migracion.' + m.id;
      if (Parametros.get(clave)) return;
      const r = m.aplicar();
      Parametros.set(clave, new Date().toISOString() + ' · ' + (r || 'ok'));
      bitacora_('', '', 'sistema', 'parametro', 'Migración aplicada: ' + m.descripcion + ' (' + (r || 'ok') + ')');
      hechas.push(m.id);
    });
    return hechas;
  },
};
