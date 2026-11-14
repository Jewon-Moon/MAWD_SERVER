import { CONFIG } from './config';

const TOKEN_KEY = 'mawd.token';
const API_KEY = 'mawd.api';

function resolveBase(): string {
  if (typeof window !== 'undefined') {
    const h = window.location.hostname;
    if (h === 'localhost' || h === '127.0.0.1') return 'http://localhost:8000';
    return localStorage.getItem(API_KEY) || CONFIG.api.base;
  }
  return CONFIG.api.base;
}

export const Api = {
  base(): string {
    return resolveBase().replace(/\/+$/, '');
  },

  token(): string {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_KEY) || '' : '';
  },

  setToken(t: string | null | undefined): void {
    if (typeof localStorage === 'undefined') return;
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  },

  async req<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...((opts.headers as Record<string, string>) || {}),
    };
    const tok = Api.token();
    if (tok) headers.Authorization = `Bearer ${tok}`;

    const res = await fetch(`${Api.base()}/v1${path}`, {
      ...opts,
      headers,
      credentials: 'include',
    });

    if (res.status === 204) return null as T;

    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!res.ok) {
      const msg = (data && (data.detail || data.message || data.error)) || `HTTP ${res.status}`;
      const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return data as T;
  },

  /* Auth */
  signup: (email: string, password: string, name: string) =>
    Api.req('/auth/signup', { method: 'POST', body: JSON.stringify({ email, password, name }) }),
  login: (email: string, password: string) =>
    Api.req('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => Api.req('/auth/logout', { method: 'POST' }).catch(() => {}),
  me: () => Api.req('/me'),

  /* Onboarding */
  templates: () => Api.req('/onboarding/templates'),
  applyOnboarding: (body: { template: string; store_name?: string; channeltalk?: { access_key: string; access_secret: string } }) =>
    Api.req('/onboarding/apply', { method: 'POST', body: JSON.stringify(body) }),

  /* Dashboard & Inquiries */
  dashboardSummary: () => Api.req('/dashboard/summary'),
  inquiries: (q: Record<string, string | number | undefined> = {}) => {
    const qs = new URLSearchParams(
      Object.entries(q)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => [k, String(v)])
    ).toString();
    return Api.req(`/inquiries${qs ? '?' + qs : ''}`);
  },
  inquiry: (id: string) => Api.req(`/inquiries/${encodeURIComponent(id)}`),
  inquiryMessages: (id: string, raw = false) =>
    Api.req(`/inquiries/${encodeURIComponent(id)}/messages?raw=${raw ? 'true' : 'false'}`),
  inquiryAction: (id: string, body: Record<string, unknown>) =>
    Api.req(`/inquiries/${encodeURIComponent(id)}/actions`, { method: 'POST', body: JSON.stringify(body) }),

  /* Calls & TTS */
  startCall: () => Api.req<{ call_id: string; greeting_text?: string }>('/calls', { method: 'POST', body: '{}' }),
  getCall: (id: string) => Api.req(`/calls/${encodeURIComponent(id)}`),
  endCall: (id: string) => Api.req(`/calls/${encodeURIComponent(id)}/end`, { method: 'POST', body: '{}' }),
  ttsUrl: async (text: string): Promise<string | null> => {
    try {
      const r = await Api.req<{ url?: string }>('/tts', { method: 'POST', body: JSON.stringify({ text }) });
      if (!r || !r.url) return null;
      return r.url.startsWith('http') ? r.url : `${Api.base()}${r.url}`;
    } catch {
      return null;
    }
  },

  /* Chats */
  sendChatMessage: (chatId: string, text: string, customer_name?: string) =>
    Api.req(`/chats/${encodeURIComponent(chatId)}/messages`, {
      method: 'POST',
      body: JSON.stringify(customer_name ? { text, customer_name } : { text }),
    }),
  getChat: (chatId: string) => Api.req(`/chats/${encodeURIComponent(chatId)}`),
  endChat: (chatId: string) => Api.req(`/chats/${encodeURIComponent(chatId)}/end`, { method: 'POST', body: '{}' }),

  /* Commerce & Orders */
  commerceConnections: () => Api.req('/commerce/connections'),
  connectCommerce: (source: string, body: Record<string, unknown>) =>
    Api.req(`/commerce/connections/${encodeURIComponent(source)}`, { method: 'PUT', body: JSON.stringify(body) }),
  disconnectCommerce: (source: string) =>
    Api.req(`/commerce/connections/${encodeURIComponent(source)}`, { method: 'DELETE' }),
  syncCommerce: (source: string) =>
    Api.req(`/commerce/connections/${encodeURIComponent(source)}/sync`, { method: 'POST', body: '{}' }),
  orders: (q: Record<string, string | number | undefined> = {}) => {
    const qs = new URLSearchParams(
      Object.entries(q)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => [k, String(v)])
    ).toString();
    return Api.req(`/orders${qs ? '?' + qs : ''}`);
  },
  importOrders: (csv: string, source = 'csv') =>
    Api.req('/orders/import', { method: 'POST', body: JSON.stringify({ source, csv, dry_run: false }) }),

  /* ChannelTalk & Instagram */
  connectChannelTalk: (access_key: string, access_secret: string) =>
    Api.req('/integrations/channeltalk', { method: 'PUT', body: JSON.stringify({ access_key, access_secret }) }),
  instagramConnection: () => Api.req('/instagram/connection'),
  connectInstagram: (access_token: string) =>
    Api.req('/instagram/connection', { method: 'PUT', body: JSON.stringify({ access_token }) }),
  disconnectInstagram: () => Api.req('/instagram/connection', { method: 'DELETE' }),
  instagramOauthUrl: () => `${Api.base()}/v1/instagram/oauth/start`,

  /* Settings & Knowledge */
  getSettings: () => Api.req('/settings'),
  patchSettings: (section: string, body: Record<string, unknown>) =>
    Api.req(`/settings/${encodeURIComponent(section)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  resetSettings: (sections?: string[]) =>
    Api.req('/settings/reset', { method: 'POST', body: JSON.stringify(sections ? { sections } : {}) }),

  contextDocs: () => Api.req('/context-docs'),
  putContextDoc: (kind: string, content_md: string) =>
    Api.req(`/context-docs/${encodeURIComponent(kind)}`, { method: 'PUT', body: JSON.stringify({ content_md }) }),
  deleteContextDoc: (kind: string) =>
    Api.req(`/context-docs/${encodeURIComponent(kind)}`, { method: 'DELETE' }),

  faqs: () => Api.req('/faqs'),
  createFaq: (question: string, answer: string) =>
    Api.req('/faqs', { method: 'POST', body: JSON.stringify({ question, answer }) }),
  patchFaq: (id: string, body: Record<string, unknown>) =>
    Api.req(`/faqs/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteFaq: (id: string) => Api.req(`/faqs/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /* Alerts */
  alerts: (since?: string) => Api.req(`/alerts${since ? '?since=' + encodeURIComponent(since) : ''}`),
  ackAlert: (id: string) => Api.req(`/alerts/${encodeURIComponent(id)}/ack`, { method: 'POST', body: '{}' }),
};
