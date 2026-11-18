/**
 * Autenticación propia: usuario + contraseña, sesiones con token.
 *  - Contraseñas: PBKDF2-HMAC-SHA256 con sal por usuario, formato "pbkdf2$iter$salHex$hashHex".
 *  - Sesiones: se guarda solo el SHA-256 del token (si alguien ve la hoja no puede usar la sesión).
 *  - Bloqueo tras CONFIG.AUTH.MAX_INTENTOS fallidos durante CONFIG.AUTH.BLOQUEO_MIN.
 */
const AuthService = {
  hashPassword: function (password, iteraciones) {
    const iter = iteraciones || CONFIG.AUTH.PBKDF2_ITERACIONES;
    const sal = Crypto.token().slice(0, 32);
    const hash = Crypto.hex(pbkdf2_(Crypto.utf8(password), Crypto.fromHex(sal), iter));
    return ['pbkdf2', iter, sal, hash].join('$');
  },

  verificarPassword: function (password, almacenado) {
    const p = String(almacenado || '').split('$');
    if (p.length !== 4 || p[0] !== 'pbkdf2') return false;
    const calc = Crypto.hex(pbkdf2_(Crypto.utf8(password), Crypto.fromHex(p[2]), Number(p[1])));
    let diff = calc.length ^ p[3].length;            // comparación en tiempo constante
    for (let i = 0; i < calc.length && i < p[3].length; i++) diff |= calc.charCodeAt(i) ^ p[3].charCodeAt(i);
    return diff === 0;
  },

  validarPolitica: function (password) {
    if (!password || password.length < CONFIG.AUTH.PASSWORD_MIN) throw new Error('La contraseña debe tener al menos ' + CONFIG.AUTH.PASSWORD_MIN + ' caracteres.');
    if (!/[A-Za-zÁÉÍÓÚáéíóúÑñ]/.test(password) || !/\d/.test(password)) throw new Error('La contraseña debe combinar letras y números.');
  },

  /** Contraseña temporal legible (sin caracteres ambiguos). */
  passwordTemporal: function () {
    const abc = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const t = Crypto.token();
    let out = '';
    for (let i = 0; i < 10; i++) out += abc[parseInt(t.substr(i * 2, 2), 16) % abc.length];
    return out.slice(0, 8) + String(parseInt(t.substr(40, 2), 16) % 90 + 10);
  },

  buscarPorUsuario: function (login) {
    const l = String(login || '').trim().toLowerCase();
    return DB.table('usuarios').where((u) => String(u.usuario || '').toLowerCase() === l)[0] || null;
  },

  login: function (login, password) {
    const generico = 'Usuario o contraseña incorrectos.';
    const u = this.buscarPorUsuario(login);
    if (!u || u.activo === false || !u.password_hash) { this.verificarPassword(password || '', 'pbkdf2$' + CONFIG.AUTH.PBKDF2_ITERACIONES + '$00$00'); throw new Error(generico); } // mismo costo: no revela si el usuario existe
    const ahora = new Date();
    if (u.bloqueado_hasta && new Date(u.bloqueado_hasta) > ahora) {
      throw new Error('Usuario bloqueado por intentos fallidos. Intenta después de las ' + Utilities.formatDate(new Date(u.bloqueado_hasta), CONFIG_TZ_(), 'HH:mm') + ' o pide a supervisión que lo desbloquee.');
    }
    if (!this.verificarPassword(password || '', u.password_hash)) {
      const intentos = Number(u.intentos_fallidos || 0) + 1;
      const patch = { intentos_fallidos: intentos };
      if (intentos >= CONFIG.AUTH.MAX_INTENTOS) {
        patch.bloqueado_hasta = new Date(ahora.getTime() + CONFIG.AUTH.BLOQUEO_MIN * 60000); patch.intentos_fallidos = 0;
        bitacora_('', '', u.usuario, 'login_bloqueado', intentos + ' intentos fallidos; bloqueado ' + CONFIG.AUTH.BLOQUEO_MIN + ' min');
      }
      DB.table('usuarios').update(u.id, patch);
      throw new Error(generico);
    }
    DB.table('usuarios').update(u.id, { intentos_fallidos: 0, bloqueado_hasta: '', ultimo_acceso: ahora });
    const token = Crypto.token();
    DB.table('sesiones').insert({
      token_hash: Crypto.sha256Hex(token), usuario_id: u.id, creada_en: ahora,
      expira_en: new Date(ahora.getTime() + CONFIG.AUTH.SESION_HORAS * 3600000), ultima_actividad: ahora,
    });
    bitacora_('', '', u.usuario, 'login', '');
    return { token: token, debe_cambiar_password: u.debe_cambiar_password === true };
  },

  /** Devuelve { sesion, usuario } o lanza error si el token no es válido. */
  validarToken: function (token) {
    if (!token) throw new Error('SESION: Inicia sesión.');
    const h = Crypto.sha256Hex(String(token));
    const s = DB.table('sesiones').where((x) => x.token_hash === h)[0];
    const ahora = Date.now();
    if (!s || s.cerrada_en || new Date(s.expira_en).getTime() < ahora ||
        ahora - new Date(s.ultima_actividad).getTime() > CONFIG.AUTH.SESION_INACTIVIDAD_MIN * 60000) {
      throw new Error('SESION: Tu sesión expiró. Vuelve a iniciar sesión.');
    }
    const u = DB.table('usuarios').find(s.usuario_id);
    if (!u || u.activo === false) throw new Error('SESION: Usuario inactivo.');
    return { sesion: s, usuario: u };
  },

  tocarSesion: function (sesionId) {
    DB.table('sesiones').update(sesionId, { ultima_actividad: new Date() });
  },

  logout: function (token) {
    const h = Crypto.sha256Hex(String(token || ''));
    DB.table('sesiones').where((x) => x.token_hash === h && !x.cerrada_en).forEach((s) => {
      DB.table('sesiones').update(s.id, { cerrada_en: new Date() });
      const u = DB.table('usuarios').find(s.usuario_id);
      if (u) bitacora_('', '', u.usuario, 'logout', '');
    });
  },

  cambiarPassword: function (usuarioId, actual, nueva) {
    const u = DB.table('usuarios').find(usuarioId);
    if (!this.verificarPassword(actual || '', u.password_hash)) throw new Error('La contraseña actual no es correcta.');
    if (actual === nueva) throw new Error('La nueva contraseña debe ser distinta.');
    this.validarPolitica(nueva);
    DB.table('usuarios').update(u.id, { password_hash: this.hashPassword(nueva), debe_cambiar_password: false });
    return true;
  },

  // ---------- Administración de usuarios ----------
  /** datos = { id?, usuario, nombre, rol, email, turno_base, estacion_id, activo } */
  guardarUsuario: function (datos, admin) {
    if (CONFIG.ROLES.indexOf(datos.rol) === -1) throw new Error('Rol inválido.');
    if (admin.rol !== 'Admin' && ['Admin', 'Supervisor'].indexOf(datos.rol) !== -1) throw new Error('Solo Admin puede crear supervisores o administradores.');
    const login = String(datos.usuario || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(login)) throw new Error('El usuario debe tener 3–30 caracteres: letras, números, punto, guion.');
    if (!datos.nombre) throw new Error('El nombre es obligatorio.');
    const otro = this.buscarPorUsuario(login);
    if (otro && otro.id !== datos.id) throw new Error('Ese nombre de usuario ya existe.');
    const campos = {
      usuario: login, nombre: datos.nombre, rol: datos.rol, email: datos.email || '',
      turno_base: datos.turno_base || '', estacion_id: datos.estacion_id || '', activo: datos.activo !== false,
      // Área de la que es jefe (solo Supervisor): vacío = todas. Los demás roles tienen su área por el rol.
      area: datos.rol === 'Supervisor' && CONFIG.BANDEJAS[datos.area] ? datos.area : '',
    };
    if (datos.id) {
      const actual = DB.table('usuarios').find(datos.id);
      if (!actual) throw new Error('Usuario no encontrado.');
      if (admin.rol !== 'Admin' && ['Admin', 'Supervisor'].indexOf(actual.rol) !== -1) throw new Error('Solo Admin puede editar supervisores o administradores.');
      if (actual.id === admin.id && (campos.activo === false || campos.rol !== actual.rol)) throw new Error('No puedes desactivarte ni cambiar tu propio rol.');
      const cambios = ['usuario', 'nombre', 'rol', 'email', 'turno_base', 'estacion_id', 'area'].filter((k) => String(actual[k] || '') !== String(campos[k] || ''))
        .map((k) => k + ': ' + (actual[k] || '—') + ' → ' + (campos[k] || '—'));
      if ((actual.activo !== false) !== campos.activo) cambios.push(campos.activo ? 'reactivado' : 'BAJA');
      bitacora_('', '', admin.login || 'sistema', 'usuario_cambio', login + (cambios.length ? ' · ' + cambios.join(' · ') : ''));
      return { usuario: this.publico(DB.table('usuarios').update(datos.id, campos)) };
    }
    const temporal = this.passwordTemporal();
    const nuevo = DB.table('usuarios').insert(Object.assign(campos, {
      password_hash: this.hashPassword(temporal), debe_cambiar_password: true, intentos_fallidos: 0, creado_en: new Date(),
    }));
    bitacora_('', '', admin.login || 'sistema', 'usuario_alta', login + ' (' + campos.rol + ')');
    return { usuario: this.publico(nuevo), password_temporal: temporal };
  },

  restablecerPassword: function (usuarioId, admin) {
    const u = DB.table('usuarios').find(usuarioId);
    if (!u) throw new Error('Usuario no encontrado.');
    if (admin.rol !== 'Admin' && ['Admin', 'Supervisor'].indexOf(u.rol) !== -1) throw new Error('Solo Admin puede restablecer a supervisores o administradores.');
    const temporal = this.passwordTemporal();
    DB.table('usuarios').update(u.id, { password_hash: this.hashPassword(temporal), debe_cambiar_password: true, intentos_fallidos: 0, bloqueado_hasta: '' });
    // Cierra sus sesiones abiertas
    DB.table('sesiones').where((s) => s.usuario_id === u.id && !s.cerrada_en).forEach((s) => DB.table('sesiones').update(s.id, { cerrada_en: new Date() }));
    bitacora_('', '', admin.login || 'sistema', 'usuario_password', u.usuario + ': contraseña temporal generada y sesiones cerradas');
    return { password_temporal: temporal };
  },

  listarUsuarios: function () {
    return DB.table('usuarios').all().map((u) => this.publico(u)).sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
  },

  /** Nunca enviar hashes al navegador. */
  publico: function (u) {
    if (!u) return u;
    return {
      id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol, email: u.email, turno_base: u.turno_base,
      estacion_id: u.estacion_id, area: u.area || '', activo: u.activo !== false, ultimo_acceso: u.ultimo_acceso,
      bloqueado: !!(u.bloqueado_hasta && new Date(u.bloqueado_hasta) > new Date()),
      debe_cambiar_password: u.debe_cambiar_password === true,
    };
  },
};
