// Client HTTP de l'API de dades (mateix origen: /api via nginx).
// Guarda el token de sessió al navegador d'aquest dispositiu.

const TOKEN_KEY = 'glp1.token';
const USER_KEY = 'glp1.user';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status; // 0 = sense connexió
  }
}

function lsGet(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function lsSet(key, value) {
  try {
    if (value === null || value === undefined) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch { /* mode privat */ }
}

/**
 * Capacitats del servidor descobertes a /me (o /health). Permeten que un
 * client nou funcioni amb un servidor vell (i a la inversa) sense trencar:
 * el client activa les funcions noves només si el servidor les anuncia.
 */
let capabilities = { apiVersion: 1, commands: false, audit: false };
export function getCapabilities() {
  return { ...capabilities };
}
function rememberCaps(data) {
  if (data && data.capabilities && typeof data.capabilities === 'object') {
    capabilities = { ...capabilities, ...data.capabilities };
  }
}

export function createApi({ baseUrl = '/api' } = {}) {
  const getToken = () => lsGet(TOKEN_KEY);
  const setToken = (t) => lsSet(TOKEN_KEY, t);
  const getStoredUser = () => {
    try { return JSON.parse(lsGet(USER_KEY) || 'null'); } catch { return null; }
  };
  const setStoredUser = (u) => lsSet(USER_KEY, u ? JSON.stringify(u) : null);

  async function req(path, { method = 'GET', body, auth = true } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const token = getToken();
    if (auth) {
      if (!token) throw new ApiError(401, 'No hi ha sessió');
      headers.Authorization = `Bearer ${token}`;
    }

    let res;
    try {
      res = await fetch(baseUrl + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, 'Sense connexió amb el servidor');
    }

    let data = null;
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    if (!res.ok) {
      const message = (data && data.error) || `Error ${res.status}`;
      const err = new ApiError(res.status, message);
      if (res.status === 401 && auth) setToken(null); // sessió caducada
      throw err;
    }
    return data || {};
  }

  return {
    getToken,
    setToken,
    getStoredUser,
    setStoredUser,

    health: async () => {
      const data = await req('/health', { auth: false });
      rememberCaps(data);
      return data;
    },

    async login(username, password) {
      const data = await req('/auth/login', { method: 'POST', body: { username, password }, auth: false });
      setToken(data.token);
      setStoredUser(data.user);
      return data;
    },

    async logout() {
      try { await req('/auth/logout', { method: 'POST', body: {} }); } catch { /* ja caducat */ }
      setToken(null);
      setStoredUser(null);
    },

    async me() {
      const data = await req('/me');
      rememberCaps(data);
      return data;
    },
    getPatients: () => req('/patients'),
    patientAudit: (id, limit = 200) => req(`/patients/${encodeURIComponent(id)}/audit?limit=${limit}`),
    putPatients: (patients) => req('/patients', { method: 'PUT', body: { patients } }),
    getDrugs: () => req('/drugs'),
    putDrugs: (drugs) => req('/drugs', { method: 'PUT', body: { drugs } }),

    getUsers: () => req('/users'),
    createUser: (user) => req('/users', { method: 'POST', body: user }),
    patchUser: (id, patch) => req(`/users/${id}`, { method: 'PATCH', body: patch }),
    deleteUser: (id) => req(`/users/${id}`, { method: 'DELETE' }),
    listTokens: () => req('/tokens'),
    createToken: (label, userId) => req('/tokens', { method: 'POST', body: { label, user_id: userId } }),
    revokeToken: (id) => req(`/tokens/${id}/revoke`, { method: 'POST', body: {} }),
  };
}

export const api = createApi();
