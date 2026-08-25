const TOKEN_KEY = 'erp_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

/** Dipanggil saat token ditolak server agar aplikasi kembali ke halaman login. */
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

function buildUrl(path, params) {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
  }
  return url.pathname + url.search;
}

async function request(method, path, { body, params } = {}) {
  const token = getToken();
  const res = await fetch(buildUrl(path, params), {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    clearToken();
    onUnauthorized();
    throw new Error('Sesi berakhir — silakan login kembali');
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || `Permintaan gagal (${res.status})`);
  return data;
}

export const api = {
  get: (path, params) => request('GET', path, { params }),
  post: (path, body) => request('POST', path, { body }),
  put: (path, body) => request('PUT', path, { body }),
  patch: (path, body) => request('PATCH', path, { body }),
  del: (path) => request('DELETE', path),

  /** Mengunduh file (Excel/PDF) dengan header Authorization. */
  async download(path, params, fallbackName = 'laporan') {
    const res = await fetch(buildUrl(path, params), {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) {
      const text = await res.text();
      let message = `Gagal mengunduh (${res.status})`;
      try { message = JSON.parse(text).error || message; } catch { /* respons bukan JSON */ }
      throw new Error(message);
    }

    const disposition = res.headers.get('Content-Disposition') || '';
    const match = /filename="?([^"]+)"?/.exec(disposition);
    const blob = await res.blob();

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = match ? match[1] : fallbackName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};
