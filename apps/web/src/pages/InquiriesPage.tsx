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

function handledLabel(handled: InquiryItem['handled']): { text: string; tone: 'green' | 'blue' | 'gray' } {
  if (handled === 'auto') return { text: '자동 처리', tone: 'green' };
  if (handled === 'sent') return { text: '답변 완료', tone: 'blue' };
  if (handled === 'manual') return { text: '직접 응대', tone: 'blue' };
  return { text: '종료(무시)', tone: 'gray' };
}

export const InquiriesPage: React.FC = () => {
  const { data, setDraft, setHandled, hydratePendingInquiries } = useApp();

  const [openRaw, setOpenRaw] = useState<Record<string, boolean>>({});
  const [rawMessages, setRawMessages] = useState<Record<string, RawMessage[]>>({});
  const [loadingRaw, setLoadingRaw] = useState<Record<string, boolean>>({});

  const { pending, handled } = useMemo(() => {
    const p: InquiryItem[] = [];
    const h: InquiryItem[] = [];
    for (const it of data.items) {
      if (!it.handled) p.push(it);
      else h.push(it);
    }
    p.sort((a, b) => b.ts - a.ts);
    h.sort((a, b) => (b.handledAt || b.ts) - (a.handledAt || a.ts));
    return { pending: p, handled: h };
  }, [data.items]);

  const unhydratedIds = useMemo(
    () => pending.filter((p) => p.server && !p.cardLoaded).map((p) => p.id),
    [pending]
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
    <Layout title="문의" subtitle={`답변 대기 ${pending.length}건 · 처리 완료 ${handled.length}건`}>
      <section className="sec">
        <div className="sec-head">
          <h2>답변할 문의 ({pending.length})</h2>
        </div>

        {pending.length === 0 ? (
          <div className="empty">
            <div className="empty-ico">✅</div>
            <div className="empty-t">대기 중인 문의가 없습니다</div>
            <div className="empty-d">AI가 보류한 문의나 사장님 확인이 필요한 문의가 이곳에 모입니다.</div>
          </div>
        ) : (
          pending.map((it) => {
            const person = normalizePerson(it.customer);
            const topic = topicOf(it.topic);
            const categoryLabel = it.category || topic?.name;
            const urgency = computeUrgency(it);
            const heatTone = it.score >= 70 ? 'red' : it.score >= 40 ? 'gold' : 'gray';
            const quoteTone = it.score >= 70 ? 'red' : it.score >= 40 ? 'gold' : '';
            const summaryText = it.card?.summary || summarizeItem(it);
            const demands = it.card?.demands || [];
            const facts = it.card?.facts;
            const draftValue = it.draft || it.card?.recommendations?.[0]?.draft || '';
            const isRawOpen = Boolean(openRaw[it.id]);
            const msgs = rawMessages[it.id] || [];

            return (
              <article key={it.id} className="card">
                <div className="row-t1" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span className="chip gray">{it.channel}</span>
                    {categoryLabel && <span className="chip blue">{categoryLabel}</span>}
                    <strong>{person.label}</strong>
                    <span style={{ fontSize: 12.5, color: 'var(--mute)' }}>{formatAgo(it.ts)}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span className={`chip ${heatTone}`}>
                      {it.heatLabel ? `${it.score}점 · ${it.heatLabel}` : `${it.score}점`}
                    </span>
                    <span className={`chip ${urgency.tone}`}>{urgency.label}</span>
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

                <div style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => void toggleRawConversation(it)}
                  >
                    {isRawOpen ? '대화 원문 닫기 ▲' : '대화 원문 보기 ▼'}
                  </button>

                  {isRawOpen && (
                    <div className="tape" style={{ marginTop: 10 }}>
                      {loadingRaw[it.id] ? (
                        <div className="hint" style={{ marginTop: 0 }}>
                          대화 내역을 불러오는 중…
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
                </div>

                <div className="field" style={{ marginTop: 14, marginBottom: 12 }}>
                  <label className="label" htmlFor={`draft-${it.id}`}>
                    사장님 답변 초안
                  </label>
                  <textarea
                    id={`draft-${it.id}`}
                    className="textarea"
                    placeholder="고객에게 보낼 답변을 작성하거나 수정해 주세요."
                    value={draftValue}
                    onChange={(e) => setDraft(it.id, e.target.value)}
                  />
                </div>

                <div className="btn-row">
                  <Link className="btn ghost sm" to={`/inquiries/${encodeURIComponent(it.id)}`}>
                    상세 보기 ›
                  </Link>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => void setHandled(it.id, 'ignored')}
                  >
                    종료(무시)
                  </button>
                  {it.server && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => void setHandled(it.id, 'manual')}
                    >
                      직접 응대(AI 끔)
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn sm"
                    style={{ marginLeft: 'auto' }}
                    onClick={() => void setHandled(it.id, 'sent', draftValue)}
                  >
                    답변 저장 및 전송
                  </button>
                </div>
              </article>
            );
          })
        )}
      </section>

      <section className="sec">
        <div className="sec-head">
          <h2>처리된 문의 ({handled.length})</h2>
        </div>

        {handled.length === 0 ? (
          <div className="note">아직 처리 완료된 문의가 없습니다.</div>
        ) : (
          <div className="list">
            {handled.map((it) => {
              const person = normalizePerson(it.customer);
              const badge = handledLabel(it.handled);

              return (
                <Link
                  key={it.id}
                  to={`/inquiries/${encodeURIComponent(it.id)}`}
                  className="row"
                >
                  <div className="row-body">
                    <div className="row-t1">
                      <span className="chip gray">{it.channel}</span>
                      <span className={`chip ${badge.tone}`}>{badge.text}</span>
                      <span>{person.label}</span>
                    </div>
                    <div className="row-t2">{summarizeItem(it)}</div>
                  </div>
                  <div className="row-val">{formatAgo(it.handledAt || it.ts)}</div>
                  <span className="chev" aria-hidden="true">
                    ›
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </Layout>
  );
};
