import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { useApp } from '../context/AppContext';
import { Api } from '../lib/api';
import { buildDraft, formatAgo } from '../lib/judge';
import type { InquiryItem, InstagramConnection } from '../lib/types';

type SnsFilter = 'all' | 'held' | 'auto';

function scoreTone(score: number, threshold: number): 'red' | 'gold' | 'green' {
  if (score >= threshold) return 'red';
  if (score >= Math.max(15, Math.floor(threshold * 0.5))) return 'gold';
  return 'green';
}

function handledBadge(it: InquiryItem): { label: string; tone: 'green' | 'blue' | 'gray' } | null {
  if (it.handled === 'auto') return { label: '자동 응대', tone: 'green' };
  if (it.handled === 'sent') return { label: '답변 완료', tone: 'blue' };
  if (it.handled === 'manual') return { label: '직접 응대', tone: 'blue' };
  if (it.handled === 'ignored') return { label: '종료됨', tone: 'gray' };
  return null;
}

export const SnsPage: React.FC = () => {
  const { data, setHandled, pullServer, showToast } = useApp();
  const [filter, setFilter] = useState<SnsFilter>('all');
  const [igConn, setIgConn] = useState<InstagramConnection | null>(null);
  const [igLoading, setIgLoading] = useState<boolean>(false);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [tokenInput, setTokenInput] = useState<string>('');
  const [connecting, setConnecting] = useState<boolean>(false);
  const [replyOpenId, setReplyOpenId] = useState<string | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const hasToken = Boolean(Api.token());
  const thHold = data.store.response.heat_threshold || data.settings.thHold || 35;

  const loadConnection = useCallback(async () => {
    if (!Api.token()) return;
    setIgLoading(true);
    try {
      const res = (await Api.instagramConnection()) as InstagramConnection | null;
      setIgConn(res || { connected: false });
    } catch {
      setIgConn({ connected: false });
    } finally {
      setIgLoading(false);
    }
  }, []);

  useEffect(() => {
    if (hasToken) {
      void loadConnection();
    }
  }, [hasToken, loadConnection]);

  const snsItems = useMemo(
    () =>
      data.items
        .filter((it) => it.channel === '인스타그램')
        .sort((a, b) => b.ts - a.ts),
    [data.items]
  );

  const counts = useMemo(() => {
    const held = snsItems.filter((it) => !it.handled || it.verdict === 'held').length;
    const auto = snsItems.filter((it) => it.handled === 'auto').length;
    return { all: snsItems.length, held, auto };
  }, [snsItems]);

  const filteredItems = useMemo(() => {
    if (filter === 'held') {
      return snsItems.filter((it) => !it.handled || it.verdict === 'held');
    }
    if (filter === 'auto') {
      return snsItems.filter((it) => it.handled === 'auto');
    }
    return snsItems;
  }, [snsItems, filter]);

  const handleConnectToken = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = tokenInput.trim();
    if (!trimmed) {
      showToast('Access Token을 입력해 주세요');
      return;
    }
    setConnecting(true);
    try {
      await Api.connectInstagram(trimmed);
      setTokenInput('');
      await loadConnection();
      showToast('인스타그램 계정을 연결했습니다');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '인스타그램 연결에 실패했습니다';
      showToast(msg);
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setConnecting(true);
    try {
      await Api.disconnectInstagram();
      setIgConn({ connected: false });
      showToast('인스타그램 연결을 해제했습니다');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '연결 해제에 실패했습니다';
      showToast(msg);
    } finally {
      setConnecting(false);
    }
  };

  const openQuickReply = (it: InquiryItem) => {
    if (replyOpenId === it.id) {
      setReplyOpenId(null);
      return;
    }
    setReplyDrafts((prev) => ({
      ...prev,
      [it.id]: prev[it.id] ?? (it.draft || buildDraft(it, data.settings, data.store)),
    }));
    setReplyOpenId(it.id);
  };

  const handleSendReply = async (it: InquiryItem) => {
    const text = (replyDrafts[it.id] || '').trim();
    if (!text) {
      showToast('답변 내용을 입력해 주세요');
      return;
    }
    setBusyId(it.id);
    try {
      await setHandled(it.id, 'sent', text);
      setReplyOpenId(null);
    } finally {
      setBusyId(null);
    }
  };

  const handleCloseItem = async (it: InquiryItem) => {
    setBusyId(it.id);
    try {
      await setHandled(it.id, 'ignored');
    } finally {
      setBusyId(null);
    }
  };

  const handleSyncComments = useCallback(async (silent = false) => {
    if (!Api.token() || syncing) return;
    setSyncing(true);
    try {
      const res = await Api.syncInstagram();
      await pullServer();
      if (!silent) {
        showToast(
          res.imported > 0
            ? `새 댓글 ${res.imported}건을 가져왔습니다`
            : `확인 완료 (새 댓글 없음 · 총 ${res.fetched}건 확인)`
        );
      }
    } catch (err: unknown) {
      if (!silent) {
        const msg = err instanceof Error ? err.message : '댓글 동기화에 실패했습니다';
        showToast(msg);
      }
    } finally {
      setSyncing(false);
    }
  }, [pullServer, showToast, syncing]);

  const isConnected = Boolean(igConn?.connected || igConn?.username || igConn?.ig_user_id);

  useEffect(() => {
    if (hasToken && isConnected) {
      void handleSyncComments(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasToken, isConnected]);

  return (
    <Layout title="SNS" subtitle="인스타그램 댓글 · 자동 숨김 · 공개 답글">
      {/* 인스타그램 연결 상태 카드 */}
      <section className="sec">
        <div className="sec-head">
          <h2>인스타그램 계정 연동</h2>
          {isConnected ? (
            <span className="chip green">연결됨</span>
          ) : (
            <span className="chip gray">미연결</span>
          )}
        </div>

        <div className="card">
          {!hasToken ? (
            <div className="note">
              로그인 후 인스타그램 계정을 연동하면 댓글 자동 숨김과 공개 답글 기능을 실시간으로 사용할 수 있어요.
            </div>
          ) : igLoading ? (
            <p className="hint">인스타그램 연결 상태를 확인하고 있습니다...</p>
          ) : isConnected ? (
            <div>
              <div className="row" style={{ padding: 0, borderBottom: 'none' }}>
                <div className="ico-box">📷</div>
                <div className="row-body">
                  <div className="row-t1">
                    {igConn?.username ? `@${igConn.username}` : '인스타그램 비즈니스 계정'}
                    <span className="chip green">활성</span>
                  </div>
                  <div className="row-t2">
                    {igConn?.ig_user_id ? `IG User ID: ${igConn.ig_user_id}` : '댓글 수집 및 자동 응대 연동 중'}
                  </div>
                </div>
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => void handleSyncComments(false)}
                    disabled={syncing || connecting}
                  >
                    {syncing ? '동기화 중...' : '댓글 새로고침'}
                  </button>
                  <button
                    type="button"
                    className="btn danger sm"
                    onClick={handleDisconnect}
                    disabled={connecting}
                  >
                    연결 해제
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div>
              <p className="row-t2" style={{ marginTop: 0, marginBottom: 14 }}>
                인스타그램 OAuth로 바로 연결하거나, Meta 개발자 콘솔에서 발급받은 Access Token을 직접 입력해 연결할 수 있어요.
              </p>

              <div className="btn-row" style={{ marginBottom: 16 }}>
                <a
                  href={Api.instagramOauthUrl()}
                  className="btn sm"
                >
                  인스타그램 OAuth 연결
                </a>
              </div>

              <form onSubmit={handleConnectToken}>
                <label className="label" htmlFor="ig-token-input">
                  수동 Access Token 연결
                </label>
                <div className="btn-row">
                  <input
                    id="ig-token-input"
                    type="password"
                    className="input"
                    style={{ flex: 1, minWidth: 220 }}
                    placeholder="IGQV... Access Token 입력"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    disabled={connecting}
                  />
                  <button
                    type="submit"
                    className="btn ghost sm"
                    disabled={connecting || !tokenInput.trim()}
                  >
                    토큰으로 연결
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      </section>

      {/* 댓글 필터 및 목록 */}
      <section className="sec">
        <div className="sec-head" style={{ flexWrap: 'wrap' }}>
          <h2>수집된 댓글</h2>
          <div className="seg" role="tablist" aria-label="SNS 댓글 필터" style={{ marginLeft: 'auto' }}>
            <button
              type="button"
              role="tab"
              aria-selected={filter === 'all'}
              className={`seg-btn ${filter === 'all' ? 'is-active' : ''}`}
              onClick={() => setFilter('all')}
            >
              전체 ({counts.all})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={filter === 'held'}
              className={`seg-btn ${filter === 'held' ? 'is-active' : ''}`}
              onClick={() => setFilter('held')}
            >
              보류/숨김 ({counts.held})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={filter === 'auto'}
              className={`seg-btn ${filter === 'auto' ? 'is-active' : ''}`}
              onClick={() => setFilter('auto')}
            >
              자동 응대 ({counts.auto})
            </button>
          </div>
        </div>

        {filteredItems.length === 0 ? (
          <div className="empty">
            <div className="empty-ico">📷</div>
            <div className="empty-t">해당하는 인스타그램 댓글이 없어요</div>
            <div className="empty-d">
              {filter === 'all'
                ? '인스타그램 계정을 연결하면 새 댓글이 이곳에 표시됩니다.'
                : '다른 필터 탭을 선택해 전체 댓글을 확인해 보세요.'}
            </div>
          </div>
        ) : (
          filteredItems.map((it) => {
            const tone = scoreTone(it.score, thHold);
            const badge = handledBadge(it);
            const isReplying = replyOpenId === it.id;
            const isBusy = busyId === it.id;

            return (
              <article key={it.id} className="card">
                <div className="row" style={{ padding: 0, borderBottom: 'none', marginBottom: 12 }}>
                  <div className="avatar">{it.customer.slice(0, 1) || '고'}</div>
                  <div className="row-body">
                    <div className="row-t1">
                      <span>{it.customer}</span>
                      <span className={`chip ${tone}`}>{it.score}점</span>
                      {badge && <span className={`chip ${badge.tone}`}>{badge.label}</span>}
                    </div>
                    <div className="row-t2">{formatAgo(it.ts)} · 인스타그램</div>
                  </div>
                </div>

                <div className={`quote ${tone === 'red' ? 'red' : tone === 'gold' ? 'gold' : ''}`}>
                  {it.text}
                </div>

                {it.hits.length > 0 && (
                  <div className="btn-row" style={{ marginTop: 10, gap: 6 }}>
                    {it.hits.map((hit) => (
                      <span key={hit} className="chip gray">
                        {hit}
                      </span>
                    ))}
                  </div>
                )}

                {it.reply && (
                  <div className="detail-block" style={{ marginTop: 12 }}>
                    <div className="detail-block-title">보낸 답글</div>
                    <div className="fact-val">{it.reply}</div>
                  </div>
                )}

                <div className="btn-row" style={{ marginTop: 14 }}>
                  <Link
                    to={`/inquiries/${encodeURIComponent(it.id)}`}
                    className="btn ghost sm"
                  >
                    상세 보기
                  </Link>
                  {!it.handled && (
                    <>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => openQuickReply(it)}
                        disabled={isBusy}
                      >
                        {isReplying ? '닫기' : '답변하기'}
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => handleCloseItem(it)}
                        disabled={isBusy}
                      >
                        종료
                      </button>
                    </>
                  )}
                </div>

                {isReplying && (
                  <div className="detail-block" style={{ marginTop: 12 }}>
                    <label className="label" htmlFor={`sns-reply-${it.id}`}>
                      공개 답글 작성
                    </label>
                    <textarea
                      id={`sns-reply-${it.id}`}
                      className="textarea"
                      rows={3}
                      value={replyDrafts[it.id] ?? ''}
                      onChange={(e) =>
                        setReplyDrafts((prev) => ({ ...prev, [it.id]: e.target.value }))
                      }
                      disabled={isBusy}
                    />
                    <div className="btn-row" style={{ marginTop: 10 }}>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => handleSendReply(it)}
                        disabled={isBusy}
                      >
                        답글 전송
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => setReplyOpenId(null)}
                        disabled={isBusy}
                      >
                        취소
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })
        )}
      </section>
    </Layout>
  );
};
