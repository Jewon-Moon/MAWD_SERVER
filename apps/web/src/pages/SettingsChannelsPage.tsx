import React, { useCallback, useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { useApp } from '../context/AppContext';
import { Api } from '../lib/api';
import { CONFIG } from '../lib/config';
import type { CommerceConnection, InstagramConnection, OrderRecord } from '../lib/types';

function extractList<T>(res: unknown, key: string): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res && typeof res === 'object') {
    const obj = res as Record<string, unknown>;
    const candidate = obj[key] ?? obj.items;
    if (Array.isArray(candidate)) return candidate as T[];
  }
  return [];
}

export const SettingsChannelsPage: React.FC = () => {
  const { data, applyMe, connectPlatform, showToast } = useApp();

  // ChannelTalk
  const [ctKey, setCtKey] = useState('');
  const [ctSecret, setCtSecret] = useState('');
  const [ctBusy, setCtBusy] = useState(false);

  // Instagram
  const [igConn, setIgConn] = useState<InstagramConnection | null>(null);
  const [igToken, setIgToken] = useState('');
  const [igBusy, setIgBusy] = useState(false);

  // Commerce & Orders
  const [connections, setConnections] = useState<CommerceConnection[]>([]);
  const [credMap, setCredMap] = useState<Record<string, Record<string, string>>>({});
  const [busySource, setBusySource] = useState<string | null>(null);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [csvText, setCsvText] = useState('');
  const [csvBusy, setCsvBusy] = useState(false);

  const loadAll = useCallback(async () => {
    if (!Api.token()) return;
    const [igRes, commRes, ordRes] = await Promise.allSettled([
      Api.instagramConnection(),
      Api.commerceConnections(),
      Api.orders({ limit: 8 }),
    ]);

    if (igRes.status === 'fulfilled' && igRes.value) {
      setIgConn(igRes.value as InstagramConnection);
    }
    if (commRes.status === 'fulfilled' && commRes.value) {
      setConnections(extractList<CommerceConnection>(commRes.value, 'connections'));
    }
    if (ordRes.status === 'fulfilled' && ordRes.value) {
      setOrders(extractList<OrderRecord>(ordRes.value, 'orders'));
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleConnectChannelTalk = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ctKey.trim() || !ctSecret.trim()) {
      showToast('Access Key와 Access Secret을 모두 입력해 주세요');
      return;
    }
    setCtBusy(true);
    try {
      await Api.connectChannelTalk(ctKey.trim(), ctSecret.trim());
      const me = await Api.me();
      applyMe(me);
      setCtKey('');
      setCtSecret('');
      showToast('채널톡이 연결되었습니다');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '채널톡 연결 실패';
      showToast(msg);
    } finally {
      setCtBusy(false);
    }
  };

  const handleConnectInstagram = async () => {
    if (!igToken.trim()) {
      showToast('액세스 토큰을 입력해 주세요');
      return;
    }
    setIgBusy(true);
    try {
      await Api.connectInstagram(igToken.trim());
      setIgToken('');
      const [igRes, me] = await Promise.all([Api.instagramConnection(), Api.me()]);
      setIgConn(igRes as InstagramConnection);
      applyMe(me);
      showToast('인스타그램이 연결되었습니다');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '인스타그램 연결 실패';
      showToast(msg);
    } finally {
      setIgBusy(false);
    }
  };

  const handleDisconnectInstagram = async () => {
    setIgBusy(true);
    try {
      await Api.disconnectInstagram();
      setIgConn({ connected: false });
      const me = await Api.me().catch(() => null);
      if (me) applyMe(me);
      showToast('인스타그램 연결을 해제했습니다');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '연결 해제 실패';
      showToast(msg);
    } finally {
      setIgBusy(false);
    }
  };

  const setFieldCred = (source: string, key: string, value: string) => {
    setCredMap((prev) => ({
      ...prev,
      [source]: {
        ...(prev[source] || {}),
        [key]: value,
      },
    }));
  };

  const refreshCommerceAndOrders = async () => {
    const [commRes, ordRes] = await Promise.allSettled([
      Api.commerceConnections(),
      Api.orders({ limit: 8 }),
    ]);
    if (commRes.status === 'fulfilled' && commRes.value) {
      setConnections(extractList<CommerceConnection>(commRes.value, 'connections'));
    }
    if (ordRes.status === 'fulfilled' && ordRes.value) {
      setOrders(extractList<OrderRecord>(ordRes.value, 'orders'));
    }
  };

  const handleConnectCommerceApi = async (platformId: string, source: string, fields: Array<{ key: string; label: string; min?: number }>) => {
    const creds = credMap[source] || {};
    for (const f of fields) {
      const v = (creds[f.key] || '').trim();
      if (!v || (f.min && v.length < f.min)) {
        showToast(`${f.label}을(를) 입력해 주세요`);
        return;
      }
    }
    setBusySource(source);
    try {
      await Api.connectCommerce(source, { mode: 'api', ...creds });
      connectPlatform(platformId, true);
      await refreshCommerceAndOrders();
      showToast('API 키로 연결되었습니다');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '커머스 연결 실패';
      showToast(msg);
    } finally {
      setBusySource(null);
    }
  };

  const handleConnectCommerceDemo = async (platformId: string, source: string) => {
    setBusySource(source);
    try {
      await Api.connectCommerce(source, { mode: 'demo' });
      connectPlatform(platformId, true);
      await refreshCommerceAndOrders();
      showToast('데모 데이터로 연결되었습니다');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '데모 연결 실패';
      showToast(msg);
    } finally {
      setBusySource(null);
    }
  };

  const handleSyncCommerce = async (source: string) => {
    setBusySource(source);
    try {
      await Api.syncCommerce(source);
      await refreshCommerceAndOrders();
      showToast('주문 데이터를 동기화했습니다');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '동기화 실패';
      showToast(msg);
    } finally {
      setBusySource(null);
    }
  };

  const handleDisconnectCommerce = async (platformId: string, source: string) => {
    setBusySource(source);
    try {
      await Api.disconnectCommerce(source);
      connectPlatform(platformId, false);
      await refreshCommerceAndOrders();
      showToast('연결을 해제했습니다');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '연결 해제 실패';
      showToast(msg);
    } finally {
      setBusySource(null);
    }
  };

  const handleImportCsv = async () => {
    if (!csvText.trim()) {
      showToast('CSV 내용을 입력해 주세요');
      return;
    }
    setCsvBusy(true);
    try {
      await Api.importOrders(csvText.trim(), 'csv');
      setCsvText('');
      const ordRes = await Api.orders({ limit: 8 });
      setOrders(extractList<OrderRecord>(ordRes, 'orders'));
      showToast('주문 CSV를 가져왔습니다');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'CSV 가져오기 실패';
      showToast(msg);
    } finally {
      setCsvBusy(false);
    }
  };

  const ctConnected = Boolean(data.integrations?.channeltalk);
  const igConnected = Boolean(igConn?.connected || data.integrations?.instagram);

  return (
    <Layout title="채널 연결" subtitle="채널톡 · 인스타그램 · 커머스 연동" backTo="/settings">
      {/* 채널톡 */}
      <section className="sec">
        <div className="sec-head">
          <h2>💬 채널톡</h2>
          <span className={`chip ${ctConnected ? 'green' : 'gray'}`} style={{ marginLeft: 'auto' }}>
            {ctConnected ? '연결됨' : '미연결'}
          </span>
        </div>
        <form className="card" onSubmit={handleConnectChannelTalk}>
          <div className="set-row">
            <div className="field">
              <label className="label" htmlFor="ct-access-key">
                Access Key
              </label>
              <input
                id="ct-access-key"
                type="text"
                className="input"
                placeholder="채널톡 Access Key"
                value={ctKey}
                onChange={(e) => setCtKey(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="ct-access-secret">
                Access Secret
              </label>
              <input
                id="ct-access-secret"
                type="password"
                className="input"
                placeholder="채널톡 Access Secret"
                value={ctSecret}
                onChange={(e) => setCtSecret(e.target.value)}
              />
            </div>
          </div>
          <div className="btn-row">
            <button type="submit" className="btn" disabled={ctBusy}>
              {ctBusy ? '연결 중...' : '연결하기'}
            </button>
          </div>
        </form>
      </section>

      {/* 인스타그램 */}
      <section className="sec">
        <div className="sec-head">
          <h2>📷 인스타그램</h2>
          <span className={`chip ${igConnected ? 'green' : 'gray'}`} style={{ marginLeft: 'auto' }}>
            {igConnected ? '연결됨' : '미연결'}
          </span>
        </div>
        <div className="card">
          {igConnected && (
            <div className="note blue" style={{ marginBottom: 14 }}>
              연결된 계정: <strong>{igConn?.username ? `@${igConn.username}` : igConn?.ig_user_id || '연결됨'}</strong>
            </div>
          )}

          <div className="btn-row" style={{ marginBottom: 14 }}>
            <a
              href={Api.instagramOauthUrl()}
              className="btn ghost sm"
              target="_blank"
              rel="noopener noreferrer"
            >
              Instagram OAuth로 연결
            </a>
            {igConnected && (
              <button
                type="button"
                className="btn danger sm"
                disabled={igBusy}
                onClick={handleDisconnectInstagram}
              >
                해제
              </button>
            )}
          </div>

          <div className="field" style={{ marginBottom: 10 }}>
            <label className="label" htmlFor="ig-manual-token">
              직접 액세스 토큰 입력
            </label>
            <input
              id="ig-manual-token"
              type="password"
              className="input"
              placeholder="IGAA... 토큰 붙여넣기"
              value={igToken}
              onChange={(e) => setIgToken(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn sm"
            disabled={igBusy}
            onClick={handleConnectInstagram}
          >
            {igBusy ? '처리 중...' : '연결'}
          </button>
        </div>
      </section>

      {/* 커머스 플랫폼 */}
      <section className="sec">
        <div className="sec-head">
          <h2>🛍 커머스 연동</h2>
        </div>

        {CONFIG.platforms.map((p) => {
          const conn = connections.find((c) => c.source === p.apiSource || c.source === p.id);
          const isConnected = Boolean(conn && conn.status !== 'disconnected');
          const isBusy = busySource === p.apiSource;
          const creds = credMap[p.apiSource] || {};

          return (
            <div key={p.id} className="card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <div className="ico-box" aria-hidden="true">
                  {p.icon}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row-t1">
                    {p.name}
                    <span className={`chip ${isConnected ? 'green' : 'gray'}`}>
                      {isConnected ? (conn?.mode === 'demo' ? '데모 연결됨' : '연결됨') : '미연결'}
                    </span>
                  </div>
                  {isConnected && (
                    <div className="row-t2">
                      주문 {conn?.order_count ?? 0}건
                      {conn?.last_synced_at ? ` · 최근 동기화: ${new Date(conn.last_synced_at).toLocaleString('ko-KR')}` : ''}
                    </div>
                  )}
                </div>

                {isConnected && (
                  <div className="btn-row">
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={isBusy}
                      onClick={() => handleSyncCommerce(p.apiSource)}
                    >
                      동기화
                    </button>
                    <button
                      type="button"
                      className="btn danger sm"
                      disabled={isBusy}
                      onClick={() => handleDisconnectCommerce(p.id, p.apiSource)}
                    >
                      해제
                    </button>
                  </div>
                )}
              </div>

              {p.connect.help && <div className="hint" style={{ marginBottom: 12 }}>{p.connect.help}</div>}
              {p.connect.note && <div className="note" style={{ marginBottom: 12 }}>{p.connect.note}</div>}

              {p.connect.method === 'api' && p.connect.fields && (
                <div className="set-row" style={{ marginBottom: 12 }}>
                  {p.connect.fields.map((f) => (
                    <div key={f.key} className="field" style={{ marginBottom: 0 }}>
                      <label className="label" htmlFor={`${p.id}-${f.key}`}>
                        {f.label}
                      </label>
                      <input
                        id={`${p.id}-${f.key}`}
                        type={f.secret ? 'password' : 'text'}
                        className="input"
                        value={creds[f.key] || ''}
                        onChange={(e) => setFieldCred(p.apiSource, f.key, e.target.value)}
                      />
                    </div>
                  ))}
                </div>
              )}

              <div className="btn-row">
                {p.connect.method === 'api' && p.connect.fields && (
                  <button
                    type="button"
                    className="btn sm"
                    disabled={isBusy}
                    onClick={() => handleConnectCommerceApi(p.id, p.apiSource, p.connect.fields!)}
                  >
                    API 키로 연결
                  </button>
                )}
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={isBusy}
                  onClick={() => handleConnectCommerceDemo(p.id, p.apiSource)}
                >
                  데모 데이터로 연결
                </button>
              </div>
            </div>
          );
        })}
      </section>

      {/* 최근 주문 및 CSV 가져오기 */}
      <section className="sec">
        <div className="sec-head">
          <h2>📦 최근 주문 ({orders.length}건)</h2>
        </div>

        {orders.length === 0 ? (
          <div className="empty" style={{ marginBottom: 16 }}>
            <div className="empty-ico">📦</div>
            <div className="empty-t">연동된 주문이 없습니다</div>
            <div className="empty-d">커머스 데모 연결 또는 아래 CSV 업로드로 주문 데이터를 불러올 수 있습니다.</div>
          </div>
        ) : (
          <div className="list" style={{ marginBottom: 16 }}>
            {orders.map((ord) => (
              <div key={ord.order_no} className="row">
                <div className="row-body">
                  <div className="row-t1">
                    <code>{ord.order_no}</code>
                    <span>{ord.item_name || ord.product_name || '상품명 없음'}</span>
                  </div>
                  <div className="row-t2">
                    {ord.customer_name || '고객'}
                    {ord.source ? ` · ${ord.source}` : ''}
                  </div>
                </div>
                {ord.status && <span className="chip gray">{ord.status}</span>}
              </div>
            ))}
          </div>
        )}

        <div className="card">
          <div className="field">
            <label className="label" htmlFor="orders-csv">
              주문 CSV 직접 가져오기
            </label>
            <textarea
              id="orders-csv"
              className="textarea"
              placeholder={'order_no,customer_name,item_name,status\nORD-1001,김민수,세라믹 머그컵,배송중'}
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn sm"
            disabled={csvBusy}
            onClick={handleImportCsv}
          >
            {csvBusy ? '가져오는 중...' : 'CSV 가져오기'}
          </button>
        </div>
      </section>
    </Layout>
  );
};
