/**
 * Archivos (adaptador de Google Drive) y conversión HTML -> PDF.
 * Las evidencias se guardan en la carpeta CONFIG.EVIDENCIAS.CARPETA del Drive del dueño del script.
 * En producción se reemplaza por almacenamiento de objetos (S3/MinIO) y un generador de PDF (p. ej. Puppeteer).
 */
const Archivos = {
  carpeta_: function () {
    const props = PropertiesService.getScriptProperties();
    const id = props.getProperty('EVIDENCIAS_FOLDER_ID');
    if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* borrada: se recrea */ } }
    const f = DriveApp.createFolder(CONFIG.EVIDENCIAS.CARPETA);
    props.setProperty('EVIDENCIAS_FOLDER_ID', f.getId());
    return f;
  },

  /** Guarda un archivo (base64) y devuelve su id. */
  guardar: function (base64, mime, nombre) {
    const blob = Utilities.newBlob(Utilities.base64Decode(base64), mime, nombre);
    return this.carpeta_().createFile(blob).getId();
  },

  /**
   * Subida por partes (PDF y video): sesión reanudable de Drive. La URL de la sesión se guarda en la caché del
   * servidor (6 h) y nunca va al navegador. En Docker: subida multiparte al almacenamiento (S3/MinIO) con la misma interfaz.
   */
  iniciarSubida: function (nombre, mime, tamano) {
    const resp = UrlFetchApp.fetch('https:' + '//www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
      method: 'post', contentType: 'application/json; charset=UTF-8', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(tamano) },
      payload: JSON.stringify({ name: nombre, parents: [this.carpeta_().getId()] }),
    });
    if (resp.getResponseCode() !== 200) throw new Error('Drive no aceptó la subida (' + resp.getResponseCode() + ').');
    const h = resp.getAllHeaders();
    const url = h.Location || h.location;
    if (!url) throw new Error('Drive no devolvió la sesión de subida.');
    return url;
  },
  guardarSesion: function (clave, url) { CacheService.getScriptCache().put('subida:' + clave, url, 21600); },
  sesion: function (clave) { return CacheService.getScriptCache().get('subida:' + clave); },
  /** Envía una parte. { listo: false } mientras faltan partes; { listo: true, archivoId } al terminar. */
  subirParte: function (sesion, inicio, base64, total) {
    const bytes = Utilities.base64Decode(base64);
    const resp = UrlFetchApp.fetch(sesion, {
      method: 'put', payload: bytes, contentType: 'application/octet-stream', muteHttpExceptions: true, followRedirects: false,
      headers: { 'Content-Range': 'bytes ' + inicio + '-' + (inicio + bytes.length - 1) + '/' + total },
    });
    const c = resp.getResponseCode();
    if (c === 308) return { listo: false };
    if (c === 200 || c === 201) return { listo: true, archivoId: JSON.parse(resp.getContentText()).id };
    throw new Error('Drive rechazó una parte del archivo (' + c + ').');
  },
  /** Comparte el archivo como "cualquiera con el enlace puede ver" y devuelve el enlace. */
  compartir: function (id) {
    const f = DriveApp.getFileById(id);
    f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return f.getUrl();
  },
  tamano: function (id) { return DriveApp.getFileById(id).getSize(); },
  /** Espacio de la cuenta de Google donde se guardan las evidencias: { usado, limite } en bytes. */
  espacio: function () { return { usado: DriveApp.getStorageUsed(), limite: DriveApp.getStorageLimit() }; },

  blob: function (id) {
    return DriveApp.getFileById(id).getBlob();
  },

  base64: function (id) {
    const b = this.blob(id);
    return { mime: b.getContentType(), data: Utilities.base64Encode(b.getBytes()) };
  },

  /** Convierte HTML a PDF (Blob). Las imágenes deben ir embebidas como data URI. */
  htmlAPdf: function (html, nombre) {
    return Utilities.newBlob(html, 'text/html', nombre + '.html').getAs('application/pdf').setName(nombre + '.pdf');
  },

  pdfBase64: function (blob) {
    return Utilities.base64Encode(blob.getBytes());
  },
};
