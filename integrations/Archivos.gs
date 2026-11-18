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
