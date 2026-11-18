/**
 * Implementación del DAL sobre Google Sheets: una hoja por tabla, fila 1 = encabezados.
 * Las columnas se mapean POR NOMBRE de encabezado, así que agregar columnas al SCHEMA
 * no rompe hojas existentes (se añaden al final). Será reemplazada por un adaptador SQL.
 */
class SheetsAdapter {
  constructor(spreadsheetId) {
    this.ss = SpreadsheetApp.openById(spreadsheetId);
  }

  /** Crea la hoja si no existe y agrega al final las columnas que falten. Devuelve [sheet, headers]. */
  ensureTable(name, columns) {
    let sheet = this.ss.getSheetByName(name);
    if (!sheet) {
      sheet = this.ss.insertSheet(name);
      sheet.getRange(1, 1, 1, columns.length).setValues([columns]).setFontWeight('bold');
      sheet.setFrozenRows(1);
      return [sheet, columns.slice()];
    }
    const lastCol = Math.max(sheet.getLastColumn(), 1);
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String).filter((h) => h !== '');
    const faltantes = columns.filter((c) => headers.indexOf(c) === -1);
    if (faltantes.length) {
      sheet.getRange(1, headers.length + 1, 1, faltantes.length).setValues([faltantes]).setFontWeight('bold');
      faltantes.forEach((c) => headers.push(c));
    }
    return [sheet, headers];
  }

  repository(name, columns) {
    const [sheet, headers] = this.ensureTable(name, columns);
    const width = headers.length;

    const readRows = () => {
      const last = sheet.getLastRow();
      if (last < 2) return [];
      return sheet.getRange(2, 1, last - 1, width).getValues().map((row, i) => {
        const obj = { _row: i + 2 };
        headers.forEach((h, j) => { obj[h] = row[j] === '' ? null : row[j]; });
        return obj;
      });
    };
    const strip = (o) => { if (!o) return o; const c = Object.assign({}, o); delete c._row; return c; };
    // Texto que empieza con = + - @ se guarda con apóstrofo para que Sheets no lo ejecute como fórmula
    // (evita "inyección de fórmulas" con lo que escriben los usuarios). getValues() lo devuelve sin apóstrofo.
    const seguro = (v) => (typeof v === 'string' && /^[=+\-@]/.test(v) && isNaN(Number(v)) ? "'" + v : v);
    const toRow = (obj) => headers.map((h) => (obj[h] === undefined || obj[h] === null ? '' : seguro(obj[h])));
    const withLock = (fn) => {
      const lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try { return fn(); } finally { lock.releaseLock(); }
    };
    const writeRow = (row, patch) => {
      const merged = Object.assign({}, row, patch);
      sheet.getRange(row._row, 1, 1, width).setValues([toRow(merged)]);
      return strip(merged);
    };

    return {
      all: () => readRows().map(strip),
      find: (id) => strip(readRows().find((r) => r.id === id) || null),
      where: (pred) => readRows().map(strip).filter(pred),
      insert: (obj) => {
        const record = Object.assign({ id: newId_() }, obj);
        withLock(() => sheet.appendRow(toRow(record)));
        return record;
      },
      insertMany: (objs) => {
        if (!objs.length) return [];
        const records = objs.map((o) => Object.assign({ id: newId_() }, o));
        withLock(() => {
          const start = sheet.getLastRow() + 1;
          sheet.getRange(start, 1, records.length, width).setValues(records.map(toRow));
        });
        return records;
      },
      update: (id, patch) => withLock(() => {
        const row = readRows().find((r) => r.id === id);
        return row ? writeRow(row, patch) : null;
      }),
      /** patches = { id: {campos} }. Una sola lectura y una sola escritura del rango. */
      updateMany: (patches) => withLock(() => {
        const rows = readRows();
        let n = 0;
        rows.forEach((r) => { if (patches[r.id]) { Object.assign(r, patches[r.id]); n++; } });
        if (n) sheet.getRange(2, 1, rows.length, width).setValues(rows.map(toRow));
        return n;
      }),
      updateIf: (id, pred, patch) => withLock(() => {
        const row = readRows().find((r) => r.id === id);
        if (!row || !pred(strip(row))) return null;
        return writeRow(row, typeof patch === 'function' ? patch(strip(row)) : patch);
      }),
    };
  }
}
