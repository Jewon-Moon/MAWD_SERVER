import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { useApp } from '../context/AppContext';
import { Api } from '../lib/api';
import { computeUrgency, formatAgo, normalizePerson, summarizeItem, topicOf } from '../lib/judge';
import type { InquiryItem, RawMessage } from '../lib/types';

function senderLabel(sender: string): string {
  if (sender === 'customer') return '👤 고객';
  if (sender === 'owner') return '👑 사장님';
  return '🛡 AI';
}

function handledChip(handled: InquiryItem['handled']): { text: string; tone: 'gold' | 'green' | 'blue' | 'gray' } {
  if (!handled) return { text: '대기 중', tone: 'gold' };
  if (handled === 'manual') return { text: '직접 응대', tone: 'blue' };
  if (handled === 'sent') return { text: '답변 완료', tone: 'blue' };
  if (handled === 'auto') return { text: 'AI 자동 응대', tone: 'green' };
  return { text: '종료', tone: 'gray' };
}

export const DemoPage: React.FC = () => {
  const { data, hydratePendingInquiries } = useApp();

  const [openRaw, setOpenRaw] = useState<Record<string, boolean>>({});
  const [rawMessages, setRawMessages] = useState<Record<string, RawMessage[]>>({});
  const [loadingRaw, setLoadingRaw] = useState<Record<string, boolean>>({});

  const callItems = useMemo(
    () => data.items.filter((it) => it.channel === '전화').sort((a, b) => b.ts - a.ts),
    [data.items]
  );

  const { pendingCount, autoCount, urgentCount } = useMemo(() => {
    let pending = 0;
    let auto = 0;
    let urgent = 0;
    for (const it of callItems) {
      if (!it.handled) pending += 1;
      if (it.handled === 'auto') auto += 1;
      if (computeUrgency(it).label === '긴급') urgent += 1;
    }
    return { pendingCount: pending, autoCount: auto, urgentCount: urgent };
  }, [callItems]);

  const unhydratedIds = useMemo(
    () => callItems.filter((it) => it.server && !it.cardLoaded).map((it) => it.id),
    [callItems]
  );

  useEffect(() => {
    if (unhydratedIds.length > 0) {
      void hydratePendingInquiries(unhydratedIds);
    }
  }, [unhydratedIds, hydratePendingInquiries]);

  const toggleRawConversation = async (it: InquiryItem) => {
    const nextOpen = !openRaw[it.id];
    setOpenRaw((prev) => ({ ...prev, [it.id]: nextOpen }));
    if (!nextOpen) return;

    if (!it.server) {
      setRawMessages((prev) => ({
        ...prev,
        [it.id]: [{ sender: 'customer', text: it.text }],
      }));
      return;
    }

    if (rawMessages[it.id]) return;

    setLoadingRaw((prev) => ({ ...prev, [it.id]: true }));
    try {
      const res = await Api.inquiryMessages(it.id, true);
      const list: RawMessage[] = Array.isArray(res)
        ? res
        : Array.isArray(res?.messages)
          ? res.messages
          : Array.isArray(res?.items)
            ? res.items
            : [];
      setRawMessages((prev) => ({
        ...prev,
        [it.id]: list.length > 0 ? list : [{ sender: 'customer', text: it.text }],
      }));
    } catch {
      setRawMessages((prev) => ({
        ...prev,
        [it.id]: [{ sender: 'customer', text: it.text }],
      }));
    } finally {
      setLoadingRaw((prev) => ({ ...prev, [it.id]: false }));
    }
  };

  return (
    <Layout title="통화 기록" subtitle="접수된 고객 통화 요약 및 대화 기록">
      <section className="sec" aria-label="통화 현황">
        <div className="stats">
          <div className="stat">
            <div className="stat-n">{callItems.length}</div>
            <div className="stat-l">전체 통화</div>
          </div>
          <div className="stat">
            <div className="stat-n">{pendingCount}</div>
            <div className="stat-l">확인 필요(대기)</div>
          </div>
          <div className="stat">
            <div className="stat-n">{autoCount}</div>
            <div className="stat-l">자동 처리</div>
          </div>
          <div className="stat">
            <div className="stat-n" style={{ color: urgentCount > 0 ? 'var(--red)' : undefined }}>
              {urgentCount}
            </div>
            <div className="stat-l">긴급</div>
          </div>
        </div>
      </section>

      <section className="sec">
        <div className="sec-head">
          <h2>접수된 통화 ({callItems.length})</h2>
        </div>

        {callItems.length === 0 ? (
          <div className="empty">
            <div className="empty-ico">📞</div>
            <div className="empty-t">통화 기록이 없습니다</div>
            <div className="empty-d">고객 통화가 접수되면 이곳에 요약과 녹취 기록이 표시됩니다.</div>
          </div>
        ) : (
          callItems.map((it) => {
            const person = normalizePerson(it.customer);
            const topic = topicOf(it.topic);
            const categoryLabel = it.category || topic?.name;
            const urgency = computeUrgency(it);
            const status = handledChip(it.handled);
            const heatTone = it.score >= 70 ? 'red' : it.score >= 40 ? 'gold' : 'gray';
            const quoteTone = it.score >= 70 ? 'red' : it.score >= 40 ? 'gold' : '';
            const summaryText = it.card?.summary || summarizeItem(it);
            const demands = it.card?.demands || [];
            const facts = it.card?.facts;
            const isRawOpen = Boolean(openRaw[it.id]);
            const msgs = rawMessages[it.id] || [];

            return (
              <article key={it.id} className="card">
                <div className="row-t1" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {categoryLabel && <span className="chip blue">{categoryLabel}</span>}
                    <strong>{person.label}</strong>
                    <span style={{ fontSize: 12.5, color: 'var(--mute)' }}>{formatAgo(it.ts)}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span className={`chip ${heatTone}`}>
                      {it.heatLabel ? `${it.score}점 · ${it.heatLabel}` : `${it.score}점`}
                    </span>
                    <span className={`chip ${urgency.tone}`}>{urgency.label}</span>
                    <span className={`chip ${status.tone}`}>{status.text}</span>
                  </div>
                </div>

                <div className={`quote ${quoteTone}`}>{summaryText}</div>

                {demands.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
                    {demands.map((d, idx) => (
                      <span key={`${it.id}-dem-${idx}`} className="chip gold">
                        요구: {d}
                      </span>
                    ))}
                  </div>
                )}

                {facts && (facts.order_data || facts.customer_claim) && (
                  <div className="fact-grid" style={{ marginTop: 12 }}>
                    {facts.order_data && (
                      <div className="fact-item">
                        <div className="fact-label">주문 정보</div>
                        <div className="fact-val">{facts.order_data}</div>
                      </div>
                    )}
                    {facts.customer_claim && (
                      <div className="fact-item">
                        <div className="fact-label">고객 주장</div>
                        <div className="fact-val">{facts.customer_claim}</div>
                      </div>
                    )}
                  </div>
                )}

                <div className="btn-row" style={{ marginTop: 14, justifyContent: 'space-between' }}>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => void toggleRawConversation(it)}
                  >
                    {isRawOpen ? '통화 원문 닫기 ▲' : '통화 원문 보기 ▼'}
                  </button>
                  <Link className="btn ghost sm" to={`/inquiries/${encodeURIComponent(it.id)}`}>
                    문의 상세 및 처리 ›
                  </Link>
                </div>

                {isRawOpen && (
                  <div className="tape" style={{ marginTop: 10 }}>
                    {loadingRaw[it.id] ? (
                      <div className="hint" style={{ marginTop: 0 }}>
                        통화 내역을 불러오는 중…
                      </div>
                    ) : (
                      msgs.map((m, idx) => {
                        const isCust = m.sender === 'customer';
                        return (
                          <div key={idx} className={`msg ${isCust ? 'cust' : ''}`}>
                            <div className="msg-av" aria-hidden="true">
                              {isCust ? '👤' : m.sender === 'owner' ? '👑' : '🛡'}
                            </div>
                            <div className="bubble">
                              <div style={{ fontSize: 11.5, opacity: 0.75, marginBottom: 3 }}>
                                {senderLabel(m.sender)}
                              </div>
                              <div>{m.text}</div>
                            </div>
                          </div>
                        );
                      })
                    )}
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
