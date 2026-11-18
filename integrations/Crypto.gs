/**
 * Primitivas criptográficas (adaptador de Google Utilities).
 * En Node se reemplaza por el módulo `crypto` con la misma interfaz.
 */
const Crypto = {
  /** HMAC-SHA256 sobre bytes; devuelve bytes (enteros -128..127 en Apps Script). */
  hmac: function (keyBytes, msgBytes) {
    return Utilities.computeHmacSha256Signature(msgBytes, keyBytes);
  },
  sha256Hex: function (texto) {
    return this.hex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, texto, Utilities.Charset.UTF_8));
  },
  utf8: function (texto) {
    return Utilities.newBlob(texto).getBytes();
  },
  hex: function (bytes) {
    return bytes.map((b) => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  },
  fromHex: function (hex) {
    const out = [];
    for (let i = 0; i < hex.length; i += 2) { const v = parseInt(hex.substr(i, 2), 16); out.push(v > 127 ? v - 256 : v); }
    return out;
  },
  /** Token aleatorio (UUID v4 usa SecureRandom): ~244 bits. */
  token: function () {
    return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  },
};

/** PBKDF2-HMAC-SHA256 (un bloque de 32 bytes). Portable: solo depende de Crypto.hmac. */
function pbkdf2_(passwordBytes, saltBytes, iteraciones) {
  let u = Crypto.hmac(passwordBytes, saltBytes.concat([0, 0, 0, 1]));
  const t = u.slice();
  for (let i = 1; i < iteraciones; i++) {
    u = Crypto.hmac(passwordBytes, u);
    for (let j = 0; j < t.length; j++) t[j] ^= u[j];
  }
  return t;
}
