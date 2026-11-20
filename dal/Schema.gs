/**
 * Esquema lógico de las tablas. Es la ÚNICA fuente de verdad de columnas:
 *  - SheetsAdapter crea las hojas y agrega columnas nuevas al final (mapea por nombre de encabezado).
 *  - db/schema.sql replica estas mismas tablas para PostgreSQL.
 * Si cambias una columna aquí, actualiza también db/schema.sql.
 */
const SCHEMA = {
  estaciones: ['id', 'nombre', 'descripcion', 'activa', 'origen', 'samsara_tag_id', 'sincronizado_en',
               'grupo'],   // grupo de apoyo: estaciones con el mismo grupo ven y atienden las alarmas de las otras
  usuarios: ['id', 'usuario', 'nombre', 'rol', 'email', 'turno_base', 'estacion_id', 'activo',
             'password_hash', 'debe_cambiar_password', 'intentos_fallidos', 'bloqueado_hasta', 'ultimo_acceso', 'creado_en',
             'area'],   // area: solo Supervisor (jefe de un área: monitoreo | seguridad_vial; vacío = todas)
  sesiones: ['id', 'token_hash', 'usuario_id', 'creada_en', 'expira_en', 'ultima_actividad', 'cerrada_en'],
  turnos: ['id', 'usuario', 'usuario_id', 'turno', 'estacion_id', 'programado_inicio', 'inicio_en', 'retardo_min',
           'fin_en', 'estatus', 'nota_entrega', 'alarmas_devueltas', 'tickets_abiertos', 'cerrado_por'],
  unidades: ['id', 'economico', 'placas', 'operador', 'cliente', 'estacion_id', 'samsara_asset_id', 'activo', 'origen', 'sincronizado_en',
             'circuito_id', 'circuitos_ids'],   // circuitos_ids: todos los de Samsara (unidades prestadas tienen 2+)

  // ---- Catálogos del negocio (docs/plan-catalogos.md) ----
  circuitos: ['id', 'nombre', 'activo'],
  /** clasificacion: Incidencia | Ocurrencia. Ocurrencia = prefijo "OCURRENCIA" en el asunto. */
  tipos_incidencia: ['id', 'nombre', 'clasificacion', 'severidad', 'sla_primer_estatus_min', 'sla_escalamiento_min',
                     'escalamiento_inmediato', 'activo', 'orden', 'actualizado_en'],
  /** Cada lista es de UN circuito y tiene su propio conjunto de tipos (tipo_ids separados por ";"). */
  listas_distribucion: ['id', 'nombre', 'circuito_id', 'tipo_ids', 'correos', 'activa', 'es_respaldo', 'actualizado_en',
                        'es_seguridad_vial'],   // la lista que recibe los reportes de Seguridad Vial
  /** Etiquetas de Samsara dentro de "GRUPO GAL". uso: circuito | dolly | remolque | empresa | ignorar */
  etiquetas_samsara: ['id', 'etiqueta', 'samsara_tag_id', 'uso', 'circuito_id', 'activo'],
  /** Qué llega de Samsara. origen: alerta (configuradas: pánico, paradas…) | seguridad (etiquetas de cámara/IA,
   *  configuracion_id = 'label:MobileUsage'). destino: monitoreo | seguridad_vial | ambos | ninguno
   *  (vigilar = destino distinto de ninguno, se conserva por compatibilidad).
   *  tipo_id = tipo de incidencia que se sugiere en el ticket. */
  alertas_samsara: ['id', 'origen', 'configuracion_id', 'nombre', 'vigilar', 'destino', 'severidad', 'tipo_id', 'habilitada_samsara',
                    'en_samsara', 'creado_en', 'actualizado_en',
                    'estaciones',    // ids de estación separados por ';' (vacío = según la etiqueta de la unidad)
                    'manual'],       // true = agregada por enlace: Samsara no la lista por API (disparador no compatible)
  /** Catálogos simples. tipo: cliente | supervisor | conductor | remolque | dolly | ruta.
   *  estatus: Activo | Inactivo | Por validar (lo escribió un monitorista y falta revisarlo). */
  catalogos: ['id', 'tipo', 'nombre', 'circuito_id', 'estatus', 'origen', 'externo_id', 'creado_por', 'creado_en', 'actualizado_en'],
  areas: ['id', 'nombre', 'emails', 'activa'],
  parametros: ['id', 'valor', 'actualizado_en'],   // id = nombre del parámetro (cursores, consecutivos)

  alarmas: ['id', 'origen', 'externo_id', 'unidad_id', 'samsara_asset_id', 'estacion_id', 'operador',
            'categoria', 'tipo_evento', 'severidad', 'lat', 'lng', 'direccion', 'url_origen',
            'recibida_en', 'estatus', 'asignado_a', 'tomada_en', 'ticket_id', 'cerrada_en', 'resultado', 'notas',
            'tipo_id', 'repeticiones', 'ultima_en', 'alertas_ids',   // tipo sugerido; alertas repetidas de la misma unidad se agrupan
            'bandeja',      // monitoreo (vacío) | seguridad_vial: qué área la atiende
            'estaciones'],  // estaciones que la ven (de la alerta, separadas por ';'); con varias, estacion_id queda vacío hasta que alguien la toma
  tickets: ['id', 'folio', 'alarma_id', 'estacion_id', 'monitorista', 'unidad_id', 'operador',
            'categoria', 'tipo_evento', 'zona_riesgo', 'descripcion', 'acciones', 'contacto_operador',
            'areas', 'destinatarios', 'lat', 'lng', 'creado_en', 'enviado_en', 'envio_error',
            'sla_primer_estatus_en', 'sla_escalamiento_en', 'primer_estatus_en', 'escalado_en',
            'estatus', 'cerrado_en', 'cerrado_por', 'conclusion',
            // Campos de las plantillas de correo y reporte (cuaderno NotebookLM)
            'fecha_ocurrencia', 'semana', 'turno', 'remolque1', 'remolque2', 'dolly', 'ruta', 'circuito',
            'operacion', 'cliente', 'supervisor', 'lugar',
            // Modelo de catálogos (paso 3): tipo + circuito -> lista(s) de distribución
            'tipo_id', 'clasificacion', 'severidad', 'circuito_id', 'listas', 'respaldo',
            // Seguridad Vial: reportes de conducta de riesgo (sin SLA)
            'bandeja', 'url_video',
            // Dirección según las coordenadas: fuente samsara | google | osm | sin_direccion (se rindió tras varios intentos)
            'direccion', 'direccion_fuente', 'direccion_en', 'direccion_intentos'],
  evidencias: ['id', 'alarma_id', 'ticket_id', 'tipo', 'nombre', 'mime', 'archivo_id', 'subido_por', 'creado_en',
               'tamano',     // bytes
               'estado',     // subiendo | (vacío = lista). Los PDF y videos se suben por partes
               'enlace'],    // enlace compartido (cuando no cupo en el correo)
  seguimientos: ['id', 'alarma_id', 'ticket_id', 'usuario', 'accion', 'nota', 'creado_en'],

  viajes: ['id', 'unidad_id', 'cliente', 'fecha_cita', 'eta_proyectado', 'estatus'],
  inactivas: ['id', 'unidad_id', 'inicio_paro', 'causa', 'responsable', 'liberacion_estimada', 'cerrada'],
  capacitaciones: ['id', 'operador', 'semana_inicio', 'modulos_completados_pct', 'safety_score', 'estatus_revision', 'sincronizado_en'],
};
