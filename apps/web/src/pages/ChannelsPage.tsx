import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { useApp } from '../context/AppContext';
import { Api } from '../lib/api';
import { CONFIG } from '../lib/config';
import type { CommerceConnection, InstagramConnection, OrderRecord } from '../lib/types';

function extractConnections(raw: unknown): CommerceConnection[] {
  if (Array.isArray(raw)) return raw as CommerceConnection[];
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.connections)) return obj.connections as CommerceConnection[];
    if (Array.isArray(obj.items)) return obj.items as CommerceConnection[];
  }
  return [];
}

function extractOrders(raw: unknown): OrderRecord[] {
  if (Array.isArray(raw)) return raw as OrderRecord[];
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.orders)) return obj.orders as OrderRecord[];
    if (Array.isArray(obj.items)) return obj.items as OrderRecord[];
  }
  return [];
}

export const ChannelsPage: React.FC = () => {
  const { data, showToast } = useApp();
  const [connections, setConnections] = useState<CommerceConnection[]>([]);
  const [igConn, setIgConn] = useState<InstagramConnection | null>(null);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [syncingSource, setSyncingSource] = useState<string | null>(null);

  const hasToken = Boolean(Api.token());

  const loadData = useCallback(async () => {
    if (!Api.token()) return;
    setLoading(true);
    try {
      const [connRes, igRes, ordRes] = await Promise.allSettled([
        Api.commerceConnections(),
        Api.instagramConnection(),
        Api.orders({ limit: 8 }),
      ]);
      if (connRes.status === 'fulfilled') {
        setConnections(extractConnections(connRes.value));
      }
      if (igRes.status === 'fulfilled') {
        setIgConn((igRes.value as InstagramConnection | null) || null);
      }
      if (ordRes.status === 'fulfilled') {
        setOrders(extractOrders(ordRes.value));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (hasToken) {
      void loadData();
    }
  }, [hasToken, loadData]);

  const handleSync = async (source: string, name: string) => {
    setSyncingSource(source);
    try {
      await Api.syncCommerce(source);
      showToast(`${name} 주문을 동기화했습니다`);
      await loadData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : `${name} 동기화에 실패했습니다`;
      showToast(msg);
    } finally {
      setSyncingSource(null);
    }
  };

  const ctConnected = Boolean(data.integrations?.channeltalk);
  const igConnected = Boolean(
    igConn?.connected || igConn?.username || igConn?.ig_user_id || data.integrations?.instagram
  );

  const localPlatformMap = new Map(
    (data.settings.platforms || []).map((p) => [p.id, p.connected])
  );
  const serverConnMap = new Map(connections.map((c) => [c.source, c]));

  return (
    <Layout title="채널" subtitle="연결된 상담 채널 및 커머스 주문 현황">
      {/* 상담 채널 허브 */}
      <section className="sec">
        <div className="sec-head">
          <h2>상담 채널</h2>
          <Link to="/settings/channels" className="more">
            연동 설정 ›
          </Link>
        </div>

        <div className="list">
          <div className="row">
            <div className="ico-box">{CONFIG.channels.hub.icon}</div>
            <div className="row-body">
              <div className="row-t1">
                <span>{CONFIG.channels.hub.name}</span>
                <span className={`chip ${ctConnected ? 'green' : 'gray'}`}>
                  {ctConnected ? '연결됨' : '미연결'}
                </span>
              </div>
              <div className="row-t2">{CONFIG.channels.hub.desc}</div>
            </div>
            <Link to="/settings/channels" className="btn ghost sm">
              설정
            </Link>
          </div>

          <div className="row">
            <div className="ico-box">📷</div>
            <div className="row-body">
              <div className="row-t1">
                <span>인스타그램</span>
                <span className={`chip ${igConnected ? 'green' : 'gray'}`}>
                  {igConnected ? '연결됨' : '미연결'}
                </span>
              </div>
              <div className="row-t2">
                {igConn?.username
                  ? `@${igConn.username} · 댓글 자동 숨김 및 답글`
                  : '인스타그램 댓글 수집 · 자동 숨김 · 공개 답글'}
              </div>
            </div>
            <Link to="/sns" className="btn ghost sm">
              관리
            </Link>
          </div>
        </div>
      </section>

      {/* 커머스 연동 플랫폼 */}
      <section className="sec">
        <div className="sec-head">
          <h2>커머스 주문 연동</h2>
          <Link to="/settings/channels" className="more">
            인증 정보 편집 ›
          </Link>
        </div>

        <div className="list">
          {CONFIG.platforms.map((p) => {
            const srv = serverConnMap.get(p.apiSource) || serverConnMap.get(p.id);
            const isSrvConnected = Boolean(
              srv && srv.status !== 'disconnected' && srv.status !== 'inactive'
            );
            const isConnected = isSrvConnected || Boolean(localPlatformMap.get(p.id));
            const isSyncing = syncingSource === p.apiSource;

            return (
              <div key={p.id} className="row">
                <div className="ico-box">{p.icon}</div>
                <div className="row-body">
                  <div className="row-t1">
                    <span>{p.name}</span>
                    <span className={`chip ${isConnected ? 'green' : 'gray'}`}>
                      {isConnected ? '연결됨' : '미연결'}
                    </span>
                    {srv?.mode && <span className="chip blue">{srv.mode}</span>}
                  </div>
                  <div className="row-t2">
                    {srv?.last_synced_at
                      ? `최근 동기화: ${new Date(srv.last_synced_at).toLocaleString('ko-KR')}`
                      : p.connect.note || p.connect.help || '주문 조회 및 배송 안내 연동'}
                    {typeof srv?.order_count === 'number' ? ` · ${srv.order_count}건` : ''}
                  </div>
                </div>
                <div className="btn-row" style={{ flexShrink: 0 }}>
                  {isConnected && hasToken && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => handleSync(p.apiSource, p.name)}
                      disabled={isSyncing}
                    >
                      {isSyncing ? '동기화 중...' : '동기화'}
                    </button>
                  )}
                  <Link to="/settings/channels" className="btn ghost sm">
                    설정
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* 최근 동기화된 주문 */}
      <section className="sec">
        <div className="sec-head">
          <h2>최근 동기화된 주문</h2>
          {hasToken && (
            <button
              type="button"
              className="more"
              onClick={() => void loadData()}
              disabled={loading}
            >
              {loading ? '불러오는 중...' : '새로고침'}
            </button>
          )}
        </div>

        {!hasToken ? (
          <div className="note">
            로그인 후 커머스 채널을 연결하면 최근 주문 내역이 이곳에 표시됩니다.
          </div>
        ) : loading && orders.length === 0 ? (
          <div className="card">
            <p className="hint" style={{ marginTop: 0 }}>
              주문 내역을 불러오는 중입니다...
            </p>
          </div>
        ) : orders.length === 0 ? (
          <div className="empty">
            <div className="empty-ico">📦</div>
            <div className="empty-t">동기화된 주문이 아직 없어요</div>
            <div className="empty-d">
              커머스 플랫폼을 연결하고 동기화를 실행하면 AI가 주문 조회에 활용할 수 있어요.
            </div>
          </div>
        ) : (
          <div className="list">
            {orders.map((ord) => (
              <div key={`${ord.source || 'ord'}-${ord.order_no}`} className="row">
                <div className="ico-box">📦</div>
                <div className="row-body">
                  <div className="row-t1">
                    <span>{ord.item_name || ord.product_name || '주문 상품'}</span>
                    {ord.status && <span className="chip blue">{ord.status}</span>}
                  </div>
                  <div className="row-t2">
                    주문번호 {ord.order_no}
                    {ord.customer_name ? ` · ${ord.customer_name}` : ''}
                    {ord.source ? ` · ${ord.source}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 확장 채널 애드온 */}
      <section className="sec">
        <div className="sec-head">
          <h2>채널 애드온</h2>
        </div>

        <div className="list">
          {CONFIG.channels.addons.map((addon) => (
            <div key={addon.name} className="row">
              <div className="ico-box">{addon.icon}</div>
              <div className="row-body">
                <div className="row-t1">
                  <span>{addon.name}</span>
                  <span className="chip gray">{addon.stage}</span>
                </div>
                <div className="row-t2">{addon.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </Layout>
  );
};
