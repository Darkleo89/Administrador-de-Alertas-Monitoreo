/**
 * Configuración central y catálogos de negocio (fuente: cuaderno "Analisis Caso de Negocio").
 * Los valores sensibles (IDs, tokens, correos) viven en Script Properties o en la hoja `areas`.
 * Al migrar a Node/Python, este objeto pasa tal cual a un módulo de configuración.
 */
const CONFIG = {
  SLA: {
    TICKET_META_MIN: 10,              // meta: notificar al área en <= 10 min desde que llega la alarma
    PRIMER_ESTATUS_MIN: 40,           // primer seguimiento: 30–40 min
    ESCALAMIENTO_ALTO_RIESGO_MIN: 60,
    ESCALAMIENTO_ZONA_SEGURA_MIN: 120,
  },
  ZONAS: ['alta', 'segura', 'amenaza_inmediata'],   // amenaza inmediata = escalamiento inmediato

  SEVERIDADES: ['critica', 'alta', 'media', 'baja'], // orden de prioridad en la consola

  /** Categorías de incidencia -> severidad por omisión y áreas que reciben el ticket. */
  CATEGORIAS: {
    'Robo / Asalto':                 { severidad: 'critica', areas: ['Protección Patrimonial', 'Jefe de Monitoreo'] },
    'Accidente / Colisión':          { severidad: 'critica', areas: ['Protección Patrimonial', 'Operaciones', 'Jefe de Monitoreo'] },
    'Autoridad / Legal / Sustancias':{ severidad: 'critica', areas: ['Jefe de Monitoreo', 'Protección Patrimonial', 'Jurídico', 'Capital Humano'] },
    'Botón de pánico':               { severidad: 'critica', areas: ['Protección Patrimonial', 'Jefe de Monitoreo'] },
    'Auxilio mecánico':              { severidad: 'alta',    areas: ['Mantenimiento', 'Operaciones'] },
    'Falla GPS / Desconexión':       { severidad: 'alta',    areas: ['Mantenimiento', 'Protección Patrimonial'] },
    'Desvío / Parada no programada': { severidad: 'alta',    areas: ['Operaciones', 'Protección Patrimonial'] },
    'Cámara obstruida':              { severidad: 'alta',    areas: ['Protección Patrimonial', 'Operaciones'] },
    'Conducta del operador':         { severidad: 'media',   areas: ['Operaciones', 'Capital Humano'] },
    'Otro':                          { severidad: 'media',   areas: ['Jefe de Monitoreo'] },
  },
  /** Área que recibe los escalamientos automáticos por SLA vencido. */
  AREA_ESCALAMIENTO: 'Jefe de Monitoreo',

  RESULTADOS_DESCARTE: ['Falso positivo', 'Sin novedad (validado con operador)', 'Duplicada'],

  SAMSARA: {
    BASE_URL: 'https://api.samsara.com',
    INTERVALO_MIN: 1,                 // frecuencia del trigger (1, 5, 10, 15 o 30)
    VENTANA_INICIAL_MIN: 60,          // primera consulta: eventos de la última hora
    /** Etiquetas de conducta (behaviorLabels) -> categoría. Se evalúan en orden con regex. */
    MAPEO_ETIQUETAS: [
      { re: /crash|collision/i,                 categoria: 'Accidente / Colisión', severidad: 'critica' },
      { re: /obstruct/i,                        categoria: 'Cámara obstruida',     severidad: 'alta' },
      { re: /mobile|phone|cell/i,               categoria: 'Conducta del operador', tipo: 'Uso de celular',        severidad: 'alta' },
      { re: /distract|inattent|drows|lookaway/i,categoria: 'Conducta del operador', tipo: 'Distracción',           severidad: 'alta' },
      { re: /brak|accel|turn|corner|swerv/i,    categoria: 'Conducta del operador', tipo: 'Conducción agresiva',   severidad: 'media' },
      { re: /speed/i,                           categoria: 'Conducta del operador', tipo: 'Exceso de velocidad',   severidad: 'media' },
    ],
    SEVERIDAD_SIN_MAPEO: 'baja',
    /** Estaciones = etiquetas hijas de esta etiqueta en Samsara; unidades = vehículos con esa etiqueta. */
    TAG_PADRE_ESTACIONES: 'Monitoreo',
    /** Circuitos (a quién se envía el ticket): etiquetas dentro de esta, traducidas con la tabla etiquetas_samsara. */
    TAG_PADRE_CIRCUITOS: 'GRUPO GAL',
    /** Si un remolque no tiene etiqueta de dolly/remolque, se considera dolly cuando su nombre coincide con esto. */
    PATRON_DOLLY: /^A?D-?\d/i,
    /** Remolques con alguna de estas etiquetas en Samsara quedan Inactivos (no se ofrecen en el ticket). */
    ETIQUETAS_REMOLQUE_INACTIVO: 'Bajas, Perdida Total',
    SYNC_ESTACIONES_MIN: 60,          // cada cuánto se re-sincronizan estaciones y unidades
    SOLO_UNIDADES_MONITOREO: true,    // solo ingresar alarmas de vehículos con etiqueta de estación
  },

  /** Tipo de incidencia que se propone en el ticket según el evento de la alarma (se evalúan en orden). */
  TIPO_SUGERIDO: [
    { re: /COLISION|CHOQUE|CRASH|ACCIDENTE/, tipo: 'COLISION' },
    { re: /CAMARA OBSTRUIDA|OBSTRUCT/, tipo: 'CAMARA OBSTRUIDA' },
    { re: /VELOCIDAD|SPEED/, tipo: 'EXCESO DE VELOCIDAD' },
    { re: /CELULAR|MOBILE|PHONE|DISTRAC|AGRESIVA|BRAK|ACCEL|CONDUCTA/, tipo: 'CONDUCTOR INDISCIPLINADO' },
    { re: /DESVIO|GEOCERC|GEOFENCE|ROUTE/, tipo: 'DESVIO DE RUTA' },
    { re: /PARADA|STOP|IDLE/, tipo: 'PARADA NO AUTORIZADA' },
    { re: /DESCONEX|BATER|DISCONNECT|UNPLUG/, tipo: 'DESCONEXION DE ENERGIA' },
    { re: /FALLA|MECANIC|FAULT|ENGINE/, tipo: 'FALLA MECANICA' },
    { re: /PONCHAD/, tipo: 'LLANTA PONCHADA' },
    { re: /ROBO|ASALTO/, tipo: 'ROBO' },
  ],

  /** Evidencias del ticket (plantilla de reporte: 1 captura de Samsara + hasta 15 fotos). */
  EVIDENCIAS: {
    MAX_FOTOS: 15,
    MAX_SAMSARA: 1,
    MAX_BYTES: 3 * 1024 * 1024,     // por imagen, ya reducida en el navegador
    TIPOS: ['image/jpeg', 'image/png'],
    CARPETA: 'Monitoreo de Flota - Evidencias',
    // Anexos (PDF y video). Límites editables en Configuración → Sistema → Parámetros (los mismos en Docker).
    MAX_PDFS: 3,
    MAX_VIDEOS: 3,
    MAX_MB_ARCHIVO: 20,              // por archivo (PDF o video)
    MAX_MB_TICKET: 30,               // total por incidencia (fotos + PDF + video)
    CORREO_MAX_MB: 20,               // lo que no quepa en el correo va como enlace
    TIPOS_PDF: ['application/pdf'],
    TIPOS_VIDEO: ['video/mp4', 'video/quicktime', 'video/3gpp'],
    PARTE_BYTES: 4 * 1024 * 1024,    // subida por partes (múltiplo de 256 KB)
  },
  EMPRESA: 'Transportes GAL',

  INACTIVAS: {
    HORAS_MINIMAS: 48,
    CAUSAS: ['Taller/Mantenimiento', 'Pensión autorizada', 'Trámite Legal/Retención de autoridad', 'Sin Operador'],
  },
  ETA: { VERDE_MARGEN_MIN: 60, AMARILLO_MARGEN_MIN: 45 },

  ROLES: ['Monitorista', 'Supervisor', 'Mantenimiento', 'Operaciones', 'Jurídico', 'Capital Humano', 'Seguridad Vial', 'Admin'],
  /** Áreas que atienden alarmas. Monitoreo: por estación y con turnos. Seguridad Vial: toda la flota, sin turnos ni SLA. */
  BANDEJAS: { monitoreo: 'Monitoreo', seguridad_vial: 'Seguridad Vial' },
  /** Seguridad Vial: cómo se cierra un evento revisado que NO genera reporte. */
  RESULTADOS_REVISION_SV: ['Sin conducta de riesgo', 'Falso positivo', 'Conducta menor (sin reporte)'],
  FOLIO_PREFIJO_SV: 'GAL-SV',
  ROLES_SUPERVISION: ['Supervisor', 'Admin'],      // ven todas las estaciones, reasignan y ven desempeño
  ROLES_CON_TURNO: ['Monitorista'],                // deben iniciar turno para operar la consola
  FOLIO_PREFIJO: 'GAL-TCK',

  /** Turnos de 8 h, operación 24/7. `fin` < `inicio` significa que cruza medianoche. */
  TURNOS: [
    { id: 'matutino',   nombre: 'Matutino',   inicio: 6,  fin: 14 },
    { id: 'vespertino', nombre: 'Vespertino', inicio: 14, fin: 22 },
    { id: 'nocturno',   nombre: 'Nocturno',   inicio: 22, fin: 6 },
  ],
  TURNO_TOLERANCIA_RETARDO_MIN: 10,
  TURNO_CIERRE_AUTOMATICO_H: 9,     // un turno abierto más de 9 h se entrega automáticamente

  AUTH: {
    SESION_HORAS: 10,               // duración máxima de una sesión
    SESION_INACTIVIDAD_MIN: 120,    // sin actividad (la consola refresca cada 20 s)
    MAX_INTENTOS: 5,                // intentos fallidos antes de bloquear
    BLOQUEO_MIN: 15,
    PBKDF2_ITERACIONES: 2000,       // limitado por Apps Script; en producción usar bcrypt/argon2
    PASSWORD_MIN: 8,
  },
};

/**
 * Lee una propiedad del script; lanza error claro si falta y es obligatoria.
 * IMPORTANTE: todas las funciones globales que NO son api_* terminan en "_" para que
 * google.script.run no pueda invocarlas desde el navegador (la app es pública con login propio).
 */
function getSetting_(key, required) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (required && !value) {
    throw new Error('Falta la propiedad del script "' + key + '". Ejecuta setup() o agrégala en Configuración del proyecto.');
  }
  return value;
}

function CONFIG_TZ_() {
  return Session.getScriptTimeZone() || 'America/Mexico_City';
}
