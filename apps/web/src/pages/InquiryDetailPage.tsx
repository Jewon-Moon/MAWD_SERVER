import React, { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { useApp } from '../context/AppContext';
import { Api } from '../lib/api';
import { computeUrgency, formatAgo, normalizePerson, summarizeItem, topicOf } from '../lib/judge';
import type { RawMessage } from '../lib/types';

function senderLabel(sender: string): string {
  if (sender === 'customer') return '👤 고객';
  if (sender === 'owner') return '👑 사장님';
  return '🛡 AI';
}

export const InquiryDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { data, setDraft, setHandled, hydrateInquiryDetail, showToast } = useApp();

  const [showRaw, setShowRaw] = useState(false);
  const [rawMessages, setRawMessages] = useState<RawMessage[]>([]);
  const [loadingRaw, setLoadingRaw] = useState(false);

  const item = useMemo(() => {
    if (!id) return undefined;
    const decoded = decodeURIComponent(id);
    return data.items.find((it) => it.id === id || it.id === decoded);
  }, [data.items, id]);

  useEffect(() => {
    if (item?.server && !item.cardLoaded) {
      void hydrateInquiryDetail(item.id);
    }
  }, [item?.id, item?.server, item?.cardLoaded, hydrateInquiryDetail]);

  const handleToggleRaw = async () => {
    if (!item) return;
    const next = !showRaw;
    setShowRaw(next);
    if (!next) return;

    if (!item.server) {
      setRawMessages([{ sender: 'customer', text: item.text }]);
      return;
    }

    if (rawMessages.length > 0) return;

    setLoadingRaw(true);
    try {
      const res = await Api.inquiryMessages(item.id, true);
      const list: RawMessage[] = Array.isArray(res)
        ? res
        : Array.isArray(res?.messages)
          ? res.messages
          : Array.isArray(res?.items)
            ? res.items
            : [];
      setRawMessages(list.length > 0 ? list : [{ sender: 'customer', text: item.text }]);
    } catch {
      setRawMessages([{ sender: 'customer', text: item.text }]);
    } finally {
      setLoadingRaw(false);
    }
  };

  if (!item) {
    return (
      <Layout title="문의 상세" backTo="/inquiries">
        <div className="empty">
          <div className="empty-ico">🔍</div>
          <div className="empty-t">문의를 찾을 수 없습니다</div>
          <div className="empty-d">삭제되었거나 존재하지 않는 문의입니다.</div>
          <div style={{ marginTop: 16 }}>
            <Link to="/inquiries" className="btn sm">
              문의 목록으로 돌아가기
            </Link>
          </div>
        </div>
      </Layout>
    );
  }

  const person = normalizePerson(item.customer);
  const topic = topicOf(item.topic);
  const categoryLabel = item.category || topic?.name;
  const urgency = computeUrgency(item);
  const heatTone = item.score >= 70 ? 'red' : item.score >= 40 ? 'gold' : 'gray';
  const quoteTone = item.score >= 70 ? 'red' : item.score >= 40 ? 'gold' : '';
  const summaryText = item.card?.summary || summarizeItem(item);
  const demands = item.card?.demands || [];
  const facts = item.card?.facts;
  const riskFlags = item.card?.risk_flags || [];
  const recommendations = item.card?.recommendations || [];
  const draftValue = item.draft || recommendations[0]?.draft || '';

  return (
    <Layout
      title="문의 상세"
      subtitle={`${person.label} · ${item.channel} · ${formatAgo(item.ts)}`}
      backTo="/inquiries"
    >
      <section className="sec">
        <div className="card">
          <div className="row-t1" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="chip gray">{item.channel}</span>
              {categoryLabel && <span className="chip blue">{categoryLabel}</span>}
              <strong>{person.label}</strong>
              <span style={{ fontSize: 12.5, color: 'var(--mute)' }}>{formatAgo(item.ts)}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span className={`chip ${heatTone}`}>
                {item.score}점{item.heatLabel ? ` · ${item.heatLabel}` : ''}
              </span>
              <span className={`chip ${urgency.tone}`}>{urgency.label}</span>
            </div>
          </div>

          <div className="detail-block">
            <div className="detail-block-title">요청 요약</div>
            <div className={`quote ${quoteTone}`}>{summaryText}</div>
          </div>

          {demands.length > 0 && (
            <div className="detail-block">
              <div className="detail-block-title">고객 요구사항</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {demands.map((d, idx) => (
                  <span key={idx} className="chip gold">
                    {d}
                  </span>
                ))}
              </div>
            </div>
          )}

          {facts && (facts.order_data || facts.customer_claim) && (
            <div className="detail-block">
              <div className="detail-block-title">확인된 사실</div>
              <div className="fact-grid">
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
            </div>
          )}

          {(riskFlags.length > 0 || item.hits.length > 0) && (
            <div className="detail-block">
              <div className="detail-block-title">위험 신호</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {riskFlags.map((flag, idx) => (
                  <span key={`rf-${idx}`} className="chip red">
                    {flag}
                  </span>
                ))}
                {item.hits.map((hit, idx) => (
                  <span key={`hit-${idx}`} className="chip gold">
                    {hit}
                  </span>
                ))}
              </div>
            </div>
          )}

          {recommendations.length > 0 && (
            <div className="detail-block">
              <div className="detail-block-title">AI 추천 답변</div>
              {recommendations.map((rec, idx) => (
                <div key={idx} className="rec-card">
                  <div className="rec-head">
                    <strong style={{ fontSize: 13.5 }}>{rec.label}</strong>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => {
                        setDraft(item.id, rec.draft);
                        showToast('추천 답변을 불러왔습니다');
                      }}
                    >
                      이 답변 불러오기
                    </button>
                  </div>
                  <div className="rec-draft">{rec.draft}</div>
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <button type="button" className="btn ghost sm" onClick={() => void handleToggleRaw()}>
              {showRaw ? '대화 원문 닫기 ▲' : '대화 원문 보기 ▼'}
            </button>

            {showRaw && (
              <div className="tape" style={{ marginTop: 10 }}>
                {loadingRaw ? (
                  <div className="hint" style={{ marginTop: 0 }}>
                    대화 내역을 불러오는 중…
                  </div>
                ) : (
                  rawMessages.map((m, idx) => {
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
        </div>
      </section>

      <section className="sec">
        <div className="card">
          <div className="sec-head" style={{ marginBottom: 12 }}>
            <h2>사장님 처리</h2>
          </div>

          <div className="field">
            <label className="label" htmlFor="detail-draft">
              답변 내용
            </label>
            <textarea
              id="detail-draft"
              className="textarea"
              placeholder="고객에게 전송할 답변을 작성해 주세요."
              value={draftValue}
              onChange={(e) => setDraft(item.id, e.target.value)}
            />
          </div>

          <div className="btn-row">
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => void setHandled(item.id, 'ignored')}
            >
              종료(무시)
            </button>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => void setHandled(item.id, 'manual')}
            >
              직접 응대(AI 끔)
            </button>
            <button
              type="button"
              className="btn sm"
              style={{ marginLeft: 'auto' }}
              onClick={() => void setHandled(item.id, 'sent', draftValue)}
            >
              답변 저장 및 전송
            </button>
          </div>
        </div>
      </section>
    </Layout>
  );
};
