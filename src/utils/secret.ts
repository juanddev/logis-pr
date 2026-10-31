/** Samarkan secret untuk ditampilkan: hanya 4 karakter awal yang terlihat. */
export function maskSecret(value: string | undefined): string {
  if (!value) return '(kosong)';
  if (value.length <= 8) return '********';
  return `${value.slice(0, 4)}…(${value.length} karakter)`;
}

/**
 * Samarkan URL webhook: query string (berisi `sig=` tanda tangan) dihapus, path dipotong.
 * URL Workflows/Power Automate = credential; siapa pun yang punya URL bisa mengirim pesan.
 */
export function redactUrl(value: string | undefined): string {
  if (!value) return '(kosong)';
  try {
    const u = new URL(value);
    const path = u.pathname.length > 24 ? `${u.pathname.slice(0, 24)}…` : u.pathname;
    return `${u.protocol}//${u.host}${path}${u.search ? '?***' : ''}`;
  } catch {
    return '(URL tidak valid)';
  }
}

/** Hapus kemunculan secret dari teks (mis. pesan error dari server) sebelum dicetak. */
export function scrub(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join('***');
  }
  return out;
}
