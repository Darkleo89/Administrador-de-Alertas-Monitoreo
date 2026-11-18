/**
 * Áreas que reciben los tickets (Protección Patrimonial, Mantenimiento, Jurídico...) y sus correos.
 * Cada categoría de incidencia notifica a una lista de áreas (CONFIG.CATEGORIAS, editable en Parámetros).
 */
const AreaService = {
  EMAIL_RE: /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/,

  listar: function () {
    ConfigService.aplicar();
    return DB.table('areas').all().map((a) => ({
      id: a.id, nombre: a.nombre, emails: a.emails || '', activa: a.activa !== false,
      categorias: Object.keys(CONFIG.CATEGORIAS).filter((c) => CONFIG.CATEGORIAS[c].areas.indexOf(a.nombre) !== -1),
      escalamiento: CONFIG.AREA_ESCALAMIENTO === a.nombre,
    })).sort((x, y) => (x.activa === y.activa ? String(x.nombre).localeCompare(String(y.nombre)) : x.activa ? -1 : 1));
  },

  normalizarEmails_: function (texto) {
    const lista = String(texto || '').split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
    lista.forEach((e) => { if (!this.EMAIL_RE.test(e)) throw new Error('Correo inválido: ' + e); });
    return lista.filter((e, i) => lista.indexOf(e) === i).join(', ');
  },

  /** datos = { id?, nombre, emails, activa } */
  guardar: function (datos, usuario) {
    ConfigService.aplicar();
    const nombre = String(datos.nombre || '').trim();
    if (!nombre || nombre.length > 60) throw new Error('El nombre del área es obligatorio (máx. 60 caracteres).');
    const emails = this.normalizarEmails_(datos.emails);
    const activa = datos.activa !== false;
    if (activa && !emails) throw new Error('Un área activa necesita al menos un correo.');
    const repo = DB.table('areas');
    const todas = repo.all();
    const otra = todas.find((a) => String(a.nombre).toLowerCase() === nombre.toLowerCase() && a.id !== datos.id);
    if (otra) throw new Error('Ya existe un área con ese nombre.');

    if (!datos.id) {
      const nueva = repo.insert({ nombre: nombre, emails: emails, activa: activa });
      bitacora_('', '', usuario.login, 'area_alta', nombre + ': ' + emails);
      return nueva;
    }
    const actual = todas.find((a) => a.id === datos.id);
    if (!actual) throw new Error('Área no encontrada.');
    const usadaEn = Object.keys(CONFIG.CATEGORIAS).filter((c) => CONFIG.CATEGORIAS[c].areas.indexOf(actual.nombre) !== -1);

    if (!activa && actual.activa !== false) {
      const unica = usadaEn.filter((c) => CONFIG.CATEGORIAS[c].areas.length === 1);
      if (unica.length) throw new Error('No se puede dar de baja: es la única área de ' + unica.join(', ') + '. Asigna otra área a esa categoría en Parámetros.');
      if (CONFIG.AREA_ESCALAMIENTO === actual.nombre) throw new Error('No se puede dar de baja: recibe los escalamientos. Cambia el área de escalamiento en Parámetros.');
    }
    const r = repo.update(datos.id, { nombre: nombre, emails: emails, activa: activa });

    // Renombrar: actualizar las categorías y el área de escalamiento que la usan
    if (actual.nombre !== nombre) {
      usadaEn.forEach((c) => ConfigService.guardar('CATEGORIAS|' + c, CONFIG.CATEGORIAS[c].areas.map((a) => (a === actual.nombre ? nombre : a)), usuario));
      if (CONFIG.AREA_ESCALAMIENTO === actual.nombre) ConfigService.guardar('AREA_ESCALAMIENTO', nombre, usuario);
    }
    // Baja: quitarla de las categorías donde no era la única
    if (!activa && actual.activa !== false) {
      usadaEn.forEach((c) => ConfigService.guardar('CATEGORIAS|' + c, CONFIG.CATEGORIAS[c].areas.filter((a) => a !== nombre), usuario));
    }
    const cambios = [];
    if (actual.nombre !== nombre) cambios.push('nombre: ' + actual.nombre + ' → ' + nombre);
    if (String(actual.emails || '') !== emails) cambios.push('correos: ' + emails);
    if ((actual.activa !== false) !== activa) cambios.push(activa ? 'reactivada' : 'baja');
    bitacora_('', '', usuario.login, 'area_cambio', nombre + (cambios.length ? ' · ' + cambios.join(' · ') : ''));
    return r;
  },
};
