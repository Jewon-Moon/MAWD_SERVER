import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Api } from '../lib/api';
import { CONFIG } from '../lib/config';
import { buildDraft, deepMerge, judgeText } from '../lib/judge';
import type { BizTypeId, InquiryItem, LocalSettings, StoreData, StoreSettingsSchema } from '../lib/types';

const STORE_KEY = 'gjbp.data.v2';

const TEMPLATE_TO_BIZ: Record<string, BizTypeId> = {
  online_shop: 'retail',
  food_beverage: 'food',
  beauty: 'beauty',
  other: 'etc',
};

function makeSeedItems(thHold: number): InquiryItem[] {
  const now = Date.now();
  return CONFIG.seed.map(([minsAgo, customer, channel, text], i) => {
    const j = judgeText(text, thHold);
    const handled: InquiryItem['handled'] = j.verdict === 'pass' ? 'auto' : false;
    return {
      id: `seed-${i + 1}`,
      ts: now - minsAgo * 60000,
      customer,
      channel,
      text,
      score: j.score,
      verdict: j.verdict,
      hits: j.hits,
      topic: j.topic,
      handled,
      handledAt: handled ? now - minsAgo * 60000 : null,
      reply: '',
      draft: '',
      reportedAt: null,
    };
  });
}

function defaultStoreData(): StoreData {
  const settings: LocalSettings = {
    ...CONFIG.defaults,
    notices: { ...CONFIG.defaults.notices },
    platforms: [],
  };
  return {
    settings,
    store: deepMerge({} as StoreSettingsSchema, CONFIG.storeSettings.defaults),
    items: makeSeedItems(settings.thHold),
    integrations: {},
    serverSynced: false,
  };
}

function loadInitialData(): StoreData {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultStoreData();
    const parsed = JSON.parse(raw) as Partial<StoreData>;
    const def = defaultStoreData();
    return {
      settings: { ...def.settings, ...(parsed.settings || {}), notices: { ...def.settings.notices, ...(parsed.settings?.notices || {}) } },
      store: deepMerge(def.store, parsed.store || {}),
      items: Array.isArray(parsed.items) ? parsed.items : def.items,
      integrations: parsed.integrations || {},
      serverSynced: !!parsed.serverSynced,
    };
  } catch {
    return defaultStoreData();
  }
}

function saveStoreData(data: StoreData): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
  } catch {
    // ignore storage quota errors
  }
}

function mapServerInquiry(raw: any): InquiryItem {
  const heatObj = raw.heat && typeof raw.heat === 'object' ? raw.heat : {};
  const score = typeof heatObj.score === 'number' ? heatObj.score : typeof raw.score === 'number' ? raw.score : 0;
  const status = raw.status || 'pending';
  const route = raw.route || '';
  const isHeld = status === 'pending' || status === 'manual' || route === 'B' || route === 'C';

  let handled: InquiryItem['handled'] = false;
  if (status === 'resolved' || status === 'closed') {
    handled = route === 'A' ? 'auto' : 'sent';
  } else if (status === 'ignored') {
    handled = 'ignored';
  }

  const tsRaw = raw.created_at || raw.updated_at || raw.ts;
  const ts = typeof tsRaw === 'number' ? tsRaw : tsRaw ? new Date(tsRaw).getTime() : Date.now();

  const chMap: Record<string, string> = {
    call: '전화',
    chat: '채널톡',
    channeltalk: '채널톡',
    instagram: '인스타그램',
    stibee: '스티비',
    kakao: '카카오채널',
  };
  const channel = chMap[String(raw.channel || '').toLowerCase()] || raw.channel || '채널톡';

  return {
    id: String(raw.id),
    ts: Number.isFinite(ts) ? ts : Date.now(),
    customer: raw.customer_name || raw.customer || '고객',
    channel,
    text: raw.summary || raw.title || raw.last_message || raw.text || '',
    score,
    verdict: isHeld ? 'held' : 'pass',
    hits: Array.isArray(heatObj.reasons) ? heatObj.reasons : [],
    topic: raw.category || null,
    handled,
    handledAt: handled ? ts : null,
    reply: raw.reply || '',
    draft: raw.draft || '',
    reportedAt: null,
    server: true,
    serverStatus: status,
    category: raw.category || '',
    heatLabel: heatObj.label || (score >= 70 ? '매우 높음' : score >= 40 ? '높음' : ''),
    card: raw.card || null,
    cardLoaded: Boolean(raw.card),
  };
}

interface AppContextValue {
  data: StoreData;
  authChecked: boolean;
  isAuthed: boolean;
  toastMsg: string;
  showToast: (msg: string) => void;
  pullServer: () => Promise<void>;
  applyMe: (me: any) => void;
  setLocalSettings: (patch: Partial<LocalSettings>) => void;
  setNotice: (id: string, on: boolean) => void;
  setStoreField: (section: string, path: string, value: unknown) => Promise<void>;
  resetStoreSection: (section: string) => Promise<void>;
  addInquiry: (text: string, channel: string, customer: string) => InquiryItem;
  setDraft: (id: string, draft: string) => void;
  setHandled: (id: string, how: 'sent' | 'manual' | 'ignored', replyText?: string) => Promise<void>;
  toggleReport: (id: string) => void;
  connectPlatform: (id: string, connected: boolean) => void;
  reseed: () => void;
  clearAll: () => void;
  logout: () => Promise<void>;
  hydrateInquiryDetail: (id: string) => Promise<void>;
  hydratePendingInquiries: (ids: string[]) => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [data, setData] = useState<StoreData>(() => loadInitialData());
  const [authChecked, setAuthChecked] = useState<boolean>(() => !Api.token());
  const [isAuthed, setIsAuthed] = useState<boolean>(() => Boolean(Api.token()));
  const [toastMsg, setToastMsg] = useState('');
  const toastTimer = useRef<number | null>(null);
  const lastAlertAt = useRef<string | undefined>(undefined);
  const hydratingRef = useRef<Set<string>>(new Set());

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(''), 2800);
  }, []);

  const updateData = useCallback((updater: (prev: StoreData) => StoreData) => {
    setData((prev) => {
      const next = updater(prev);
      saveStoreData(next);
      return next;
    });
  }, []);

  const applyMe = useCallback(
    (me: any) => {
      if (!me) return;
      const tenant = me.tenant || me.store || {};
      const user = me.user || me.owner || {};
      const setup = me.setup || {};
      const isDone =
        typeof setup.done === 'boolean'
          ? setup.done
          : typeof setup.onboarded === 'boolean'
            ? setup.onboarded
            : undefined;
      updateData((prev) => {
        const nextSettings: LocalSettings = {
          ...prev.settings,
          storeName: tenant.name || prev.settings.storeName,
          ownerName: user.name || prev.settings.ownerName,
          email: user.email || prev.settings.email,
          onboarded: typeof isDone === 'boolean' ? isDone : prev.settings.onboarded,
          bizType: (setup.template && TEMPLATE_TO_BIZ[setup.template]) || prev.settings.bizType,
        };
        return {
          ...prev,
          settings: nextSettings,
          integrations: me.integrations || prev.integrations,
        };
      });
      setIsAuthed(true);
    },
    [updateData]
  );

  const pullServer = useCallback(async () => {
    if (!Api.token()) return;
    const [inqsRes, setRes] = await Promise.allSettled([
      Api.inquiries({ limit: 30 }),
      Api.getSettings(),
    ]);
    updateData((prev) => {
      let next = { ...prev, serverSynced: true };
      if (setRes.status === 'fulfilled' && setRes.value) {
        const srv = setRes.value.settings || setRes.value;
        next.store = deepMerge(prev.store, srv);
      }
      if (inqsRes.status === 'fulfilled' && inqsRes.value) {
        const rawList = Array.isArray(inqsRes.value)
          ? inqsRes.value
          : inqsRes.value.items || inqsRes.value.inquiries || [];
        const prevMap = new Map(prev.items.map((x) => [x.id, x]));
        const mapped: InquiryItem[] = rawList.map((r: any) => {
          const m = mapServerInquiry(r);
          const old = prevMap.get(m.id);
          if (old) {
            m.draft = old.draft || m.draft;
            if (!m.card && old.card) {
              m.card = old.card;
              m.cardLoaded = old.cardLoaded;
            }
          }
          return m;
        });
        next.items = mapped;
      }
      return next;
    });
  }, [updateData]);

  useEffect(() => {
    let alive = true;
    async function init() {
      const tok = Api.token();
      if (!tok) {
        if (alive) {
          setIsAuthed(false);
          setAuthChecked(true);
        }
        return;
      }
      try {
        const [me] = await Promise.all([Api.me(), pullServer().catch(() => {})]);
        if (!alive) return;
        applyMe(me);
        setIsAuthed(true);
      } catch (e: any) {
        if (!alive) return;
        if (e?.status === 401 || e?.status === 403) {
          Api.setToken(null);
          setIsAuthed(false);
        } else {
          setIsAuthed(true);
        }
      } finally {
        if (alive) setAuthChecked(true);
      }
    }
    init();
    return () => {
      alive = false;
    };
  }, [applyMe, pullServer]);

  // Real-time SSE updates (with auto-reconnect)
  useEffect(() => {
    if (!isAuthed || !Api.token()) return;

    let cancelled = false;
    let ac: AbortController | null = null;
    let reconnectTimer: number | null = null;

    const scheduleReconnect = (delayMs = 3000) => {
      if (cancelled) return;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(() => {
        void connect();
      }, delayMs);
    };

    const handleSseFrame = (frame: string) => {
      let eventName = 'message';
      const dataLines: string[] = [];

      for (const line of frame.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      if (dataLines.length === 0 && eventName === 'message') return;

      let payload: Record<string, unknown> | null = null;
      if (dataLines.length > 0) {
        const rawData = dataLines.join('\n');
        try {
          const parsed: unknown = JSON.parse(rawData);
          if (parsed && typeof parsed === 'object') {
            payload = parsed as Record<string, unknown>;
          }
        } catch {
          // ignore non-JSON SSE payloads
        }
      }

      const kind = eventName !== 'message' ? eventName : String(payload?.type || '');
      if (kind === 'alert') {
        void pullServer();
        if (typeof payload?.created_at === 'string') {
          lastAlertAt.current = payload.created_at;
        }
        const msg = payload?.title || payload?.message;
        if (typeof msg === 'string' && msg.trim()) {
          showToast(msg);
        }
      } else if (kind === 'inquiry') {
        void pullServer();
      }
    };

    const connect = async () => {
      const tok = Api.token();
      if (cancelled || !tok) return;

      ac = new AbortController();
      try {
        const res = await fetch(`${Api.base()}/v1/events/stream`, {
          headers: {
            Authorization: `Bearer ${tok}`,
            Accept: 'text/event-stream',
          },
          credentials: 'include',
          signal: ac.signal,
        });

        if (!res.ok || !res.body) {
          scheduleReconnect(3000);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');

          let idx = buffer.indexOf('\n\n');
          while (idx !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            handleSseFrame(frame);
            idx = buffer.indexOf('\n\n');
          }
        }

        if (!cancelled) {
          scheduleReconnect(3000);
        }
      } catch (err: unknown) {
        if (!cancelled && !(err instanceof DOMException && err.name === 'AbortError')) {
          scheduleReconnect(3000);
        }
      }
    };

    void connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      ac?.abort();
    };
  }, [isAuthed, pullServer, showToast]);

  // 15s background polling for inquiries + alerts (fallback)
  useEffect(() => {
    if (!isAuthed || !Api.token()) return;
    const timer = window.setInterval(async () => {
      try {
        await pullServer();
        const alertsRes = await Api.alerts(lastAlertAt.current).catch(() => null);
        const list = alertsRes?.items || alertsRes?.alerts || (Array.isArray(alertsRes) ? alertsRes : []);
        if (list.length > 0) {
          const newest = list[0];
          if (newest?.created_at) lastAlertAt.current = newest.created_at;
          showToast(newest?.title || newest?.message || '새 긴급 알림이 도착했습니다');
        }
      } catch {
        // ignore transient polling errors
      }
    }, 15000);
    return () => window.clearInterval(timer);
  }, [isAuthed, pullServer, showToast]);

  const hydrateInquiryDetail = useCallback(
    async (id: string) => {
      if (!Api.token() || hydratingRef.current.has(id)) return;
      hydratingRef.current.add(id);
      try {
        const detail = await Api.inquiry(id);
        const card = detail?.card || detail?.inquiry?.card || null;
        const raw = detail?.inquiry || detail || {};
        updateData((prev) => ({
          ...prev,
          items: prev.items.map((it) => {
            if (it.id !== id) return it;
            const recs = card?.recommendations || [];
            return {
              ...it,
              card: card || it.card,
              cardLoaded: true,
              draft: it.draft || (recs[0]?.draft ?? ''),
              category: raw.category || it.category,
              serverStatus: raw.status || it.serverStatus,
            };
          }),
        }));
      } catch {
        updateData((prev) => ({
          ...prev,
          items: prev.items.map((it) => (it.id === id ? { ...it, cardLoaded: true } : it)),
        }));
      } finally {
        hydratingRef.current.delete(id);
      }
    },
    [updateData]
  );

  const hydratePendingInquiries = useCallback(
    async (ids: string[]) => {
      if (!Api.token()) return;
      const toFetch = ids.filter((id) => !hydratingRef.current.has(id)).slice(0, 6);
      await Promise.allSettled(toFetch.map((id) => hydrateInquiryDetail(id)));
    },
    [hydrateInquiryDetail]
  );

  const setLocalSettings = useCallback(
    (patch: Partial<LocalSettings>) => {
      updateData((prev) => {
        const nextSettings = { ...prev.settings, ...patch };
        let nextItems = prev.items;
        if (typeof patch.thHold === 'number' && !prev.serverSynced) {
          nextItems = prev.items.map((it) => {
            if (it.server || it.handled === 'sent' || it.handled === 'ignored') return it;
            const verdict = it.score >= nextSettings.thHold ? 'held' : 'pass';
            return {
              ...it,
              verdict,
              handled: verdict === 'pass' ? 'auto' : false,
            };
          });
        }
        return { ...prev, settings: nextSettings, items: nextItems };
      });
    },
    [updateData]
  );

  const setNotice = useCallback(
    (id: string, on: boolean) => {
      updateData((prev) => ({
        ...prev,
        settings: {
          ...prev.settings,
          notices: { ...prev.settings.notices, [id]: on },
        },
      }));
    },
    [updateData]
  );

  const setStoreField = useCallback(
    async (section: string, path: string, value: unknown) => {
      const parts = path.split('.');
      let patchBody: Record<string, unknown> = {};
      let cur: Record<string, unknown> = patchBody;
      parts.forEach((p, idx) => {
        if (idx === parts.length - 1) cur[p] = value;
        else {
          cur[p] = {};
          cur = cur[p] as Record<string, unknown>;
        }
      });

      updateData((prev) => ({
        ...prev,
        store: deepMerge(prev.store, { [section]: patchBody }),
      }));

      if (Api.token()) {
        try {
          const res = await Api.patchSettings(section, patchBody);
          if (res?.settings) {
            updateData((prev) => ({ ...prev, store: deepMerge(prev.store, res.settings) }));
          }
          showToast('설정이 저장되었습니다');
        } catch (e: any) {
          showToast(e?.message || '설정 저장 실패');
        }
      } else {
        showToast('로컬에 저장되었습니다');
      }
    },
    [showToast, updateData]
  );

  const resetStoreSection = useCallback(
    async (section: string) => {
      if (!Api.token()) return;
      try {
        const res = await Api.resetSettings([section]);
        if (res?.settings) {
          updateData((prev) => ({ ...prev, store: deepMerge(prev.store, res.settings) }));
        } else {
          await pullServer();
        }
        showToast('기본값으로 복원했습니다');
      } catch (e: any) {
        showToast(e?.message || '복원 실패');
      }
    },
    [pullServer, showToast, updateData]
  );

  const addInquiry = useCallback(
    (text: string, channel: string, customer: string): InquiryItem => {
      const j = judgeText(text, data.settings.thHold);
      const handled: InquiryItem['handled'] = j.verdict === 'pass' ? 'auto' : false;
      const item: InquiryItem = {
        id: `inq-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        ts: Date.now(),
        customer: customer.trim() || '고객',
        channel,
        text,
        score: j.score,
        verdict: j.verdict,
        hits: j.hits,
        topic: j.topic,
        handled,
        handledAt: handled ? Date.now() : null,
        reply: '',
        draft: '',
        reportedAt: null,
      };
      item.draft = buildDraft(item, data.settings, data.store);
      updateData((prev) => ({
        ...prev,
        items: [item, ...prev.items],
      }));
      return item;
    },
    [data.settings, data.store, updateData]
  );

  const setDraft = useCallback(
    (id: string, draft: string) => {
      updateData((prev) => ({
        ...prev,
        items: prev.items.map((it) => (it.id === id ? { ...it, draft } : it)),
      }));
    },
    [updateData]
  );

  const setHandled = useCallback(
    async (id: string, how: 'sent' | 'manual' | 'ignored', replyText?: string) => {
      const target = data.items.find((it) => it.id === id);
      if (target?.server && Api.token()) {
        try {
          if (how === 'sent') {
            await Api.inquiryAction(id, { type: 'edit_send', text: replyText || target.draft || target.reply || '확인 후 안내드리겠습니다.' });
          } else if (how === 'manual') {
            await Api.inquiryAction(id, { type: 'manual' });
          } else {
            await Api.inquiryAction(id, { type: 'close' });
          }
          await pullServer();
          showToast(how === 'sent' ? '답변을 전송했습니다' : how === 'manual' ? '직접 응대로 전환했습니다' : '문의를 종료했습니다');
          return;
        } catch (e: any) {
          showToast(e?.message || '처리 중 오류가 발생했습니다');
          return;
        }
      }

      updateData((prev) => ({
        ...prev,
        items: prev.items.map((it) =>
          it.id === id
            ? {
                ...it,
                handled: how,
                handledAt: Date.now(),
                reply: how === 'sent' ? replyText ?? it.draft ?? it.reply : it.reply,
              }
            : it
        ),
      }));
      showToast(how === 'sent' ? '답변을 저장했습니다' : how === 'manual' ? '직접 응대로 전환했습니다' : '문의를 종료했습니다');
    },
    [data.items, pullServer, showToast, updateData]
  );

  const toggleReport = useCallback(
    (id: string) => {
      updateData((prev) => ({
        ...prev,
        items: prev.items.map((it) =>
          it.id === id ? { ...it, reportedAt: it.reportedAt ? null : Date.now() } : it
        ),
      }));
    },
    [updateData]
  );

  const connectPlatform = useCallback(
    (id: string, connected: boolean) => {
      updateData((prev) => {
        const list = [...(prev.settings.platforms || [])];
        const idx = list.findIndex((p) => p.id === id);
        if (idx >= 0) list[idx] = { id, connected };
        else list.push({ id, connected });
        return { ...prev, settings: { ...prev.settings, platforms: list } };
      });
    },
    [updateData]
  );

  const reseed = useCallback(() => {
    updateData((prev) => ({
      ...prev,
      items: makeSeedItems(prev.settings.thHold),
    }));
    showToast(`더미 데이터 ${CONFIG.seed.length}건을 불러왔습니다`);
  }, [showToast, updateData]);

  const clearAll = useCallback(() => {
    updateData((prev) => ({
      ...prev,
      items: [],
    }));
    showToast('모든 문의를 비웠습니다');
  }, [showToast, updateData]);

  const logout = useCallback(async () => {
    await Api.logout();
    Api.setToken(null);
    setIsAuthed(false);
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({
      data,
      authChecked,
      isAuthed,
      toastMsg,
      showToast,
      pullServer,
      applyMe,
      setLocalSettings,
      setNotice,
      setStoreField,
      resetStoreSection,
      addInquiry,
      setDraft,
      setHandled,
      toggleReport,
      connectPlatform,
      reseed,
      clearAll,
      logout,
      hydrateInquiryDetail,
      hydratePendingInquiries,
    }),
    [
      data,
      authChecked,
      isAuthed,
      toastMsg,
      showToast,
      pullServer,
      applyMe,
      setLocalSettings,
      setNotice,
      setStoreField,
      resetStoreSection,
      addInquiry,
      setDraft,
      setHandled,
      toggleReport,
      connectPlatform,
      reseed,
      clearAll,
      logout,
      hydrateInquiryDetail,
      hydratePendingInquiries,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
