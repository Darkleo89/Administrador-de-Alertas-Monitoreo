/**
 * Capa de Abstracción de Datos (DAL).
 *
 * Los servicios SOLO usan DB.table('nombre') y sus métodos. Nunca llaman a
 * SpreadsheetApp directamente. Así, al migrar a Node/Python + SQL basta con
 * reimplementar este contrato contra PostgreSQL, sin tocar la lógica de negocio.
 *
 * Contrato del repositorio:
 *   all()                          -> Array<Object>
 *   find(id)                       -> Object | null
 *   where(predicate)               -> Array<Object>
 *   insert(obj)                    -> Object (con id asignado)
 *   update(id, patch)              -> Object | null
 *   insertMany(objs)               -> Array<Object>
 *   updateMany({ id: patch, ... }) -> número de filas actualizadas (en SQL: transacción con varios UPDATE)
 *   updateIf(id, predicate, patch) -> Object | null   (atómico: solo actualiza si predicate(actual) es true;
 *                                                      en SQL: UPDATE ... WHERE id = ? AND <condición>)
 */
const DB = (function () {
  let adapter = null;

  function getAdapter() {
    if (!adapter) adapter = new SheetsAdapter(getSetting_('SPREADSHEET_ID', true));
    return adapter;
  }

  return {
    table: function (name) {
      if (!SCHEMA[name]) throw new Error('Tabla desconocida: ' + name);
      return getAdapter().repository(name, SCHEMA[name]);
    },
    /** Permite inyectar otro adaptador (p. ej. en pruebas). */
    useAdapter: function (a) { adapter = a; },
  };
})();

/** Genera un id único (equivalente a UUID en SQL). */
function newId_() {
  return Utilities.getUuid();
}
