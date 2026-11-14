import React, { useMemo } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { useApp } from '../context/AppContext';
import { formatAgo, groupCustomers, summarizeItem } from '../lib/judge';
import type { InquiryItem } from '../lib/types';

function scoreTone(score: number, threshold: number): 'red' | 'gold' | 'gray' {
  if (score >= threshold) return 'red';
  if (score >= Math.max(15, Math.floor(threshold * 0.5))) return 'gold';
  return 'gray';
}

function statusChip(it: InquiryItem): { label: string; tone: 'red' | 'green' | 'blue' | 'gray' } {
  if (!it.handled) return { label: '미처리', tone: 'red' };
  if (it.handled === 'auto') return { label: '자동 응대', tone: 'green' };
  if (it.handled === 'sent') return { label: '답변 완료', tone: 'blue' };
  if (it.handled === 'manual') return { label: '직접 응대', tone: 'blue' };
  return { label: '종료', tone: 'gray' };
}

export const CustomersPage: React.FC = () => {
  const { data } = useApp();
  const navigate = useNavigate();
  const { id: paramId } = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams();
  const queryId = searchParams.get('id');

  const thHold = data.store.response.heat_threshold || data.settings.thHold || 35;
  const groups = useMemo(() => groupCustomers(data.items), [data.items]);

  const rawTargetId = paramId ?? queryId ?? null;
  const selected = useMemo(() => {
    if (groups.length === 0) return null;
    if (rawTargetId) {
      const decoded = decodeURIComponent(rawTargetId);
      const found = groups.find((g) => g.id === rawTargetId || g.id === decoded);
      if (found) return found;
    }
    return groups[0];
  }, [groups, rawTargetId]);

  const chronologicalItems = useMemo(() => {
    if (!selected) return [];
    return [...selected.items].sort((a, b) => a.ts - b.ts);
  }, [selected]);

  const totalPending = useMemo(
    () => groups.reduce((acc, g) => acc + g.pending, 0),
    [groups]
  );

  return (
    <Layout
      title="고객"
      subtitle={`총 ${groups.length}명의 고객 · 미처리 ${totalPending}건`}
    >
      {groups.length === 0 ? (
        <div className="empty">
          <div className="empty-ico">👤</div>
          <div className="empty-t">아직 등록된 고객 이력이 없어요</div>
          <div className="empty-d">
            채널톡, 전화, 인스타그램 등 채널에서 문의가 들어오면 고객별로 자동 묶여 표시됩니다.
          </div>
        </div>
      ) : (
        <div className="split">
          {/* 좌측 고객 목록 */}
          <div className="pane-list">
            <div className="sec-head">
              <h2>고객 목록</h2>
              <span className="row-val">{groups.length}명</span>
            </div>

            <div className="list">
              {groups.map((c) => {
                const isSelected = selected?.id === c.id;
                const tone = scoreTone(c.worst, thHold);
                const avatarText = c.person.icon || c.person.label.slice(0, 1) || '?';

                return (
                  <button
                    key={c.id}
                    type="button"
                    className="row"
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      background: isSelected ? 'var(--soft-2)' : undefined,
                      borderLeft: isSelected ? '3px solid var(--ink)' : '3px solid transparent',
                    }}
                    onClick={() => navigate(`/customers/${encodeURIComponent(c.id)}`)}
                  >
                    <div className={`avatar ${c.person.kind === 'none' ? 'muted' : ''}`}>
                      {avatarText}
                    </div>
                    <div className="row-body">
                      <div className="row-t1">
                        <span>{c.person.label}</span>
                        {c.pending > 0 && (
                          <span className="chip red">미처리 {c.pending}</span>
                        )}
                      </div>
                      <div className="row-t2">
                        {Array.from(c.channels).join(' · ')} · {formatAgo(c.last)}
                      </div>
                    </div>
                    <div className="row-val">
                      <span className={`chip ${tone}`}>{c.worst}점</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 우측 고객 상세 */}
          <div className="pane-detail">
            {selected && (
              <>
                <div className="card">
                  <div className="row" style={{ padding: 0, borderBottom: 'none' }}>
                    <div
                      className={`avatar ${selected.person.kind === 'none' ? 'muted' : ''}`}
                      style={{ width: 48, height: 48, fontSize: 18 }}
                    >
                      {selected.person.icon || selected.person.label.slice(0, 1) || '?'}
                    </div>
                    <div className="row-body">
                      <div className="row-t1" style={{ fontSize: 17 }}>
                        <span>{selected.person.label}</span>
                        <span className={`chip ${scoreTone(selected.worst, thHold)}`}>
                          최고 {selected.worst}점
                        </span>
                      </div>
                      <div className="row-t2">
                        {selected.person.sub ? `${selected.person.sub} · ` : ''}
                        최근 문의 {formatAgo(selected.last)}
                      </div>
                    </div>
                  </div>

                  <div className="detail-block" style={{ marginTop: 16 }}>
                    <div className="fact-grid">
                      <div className="fact-item">
                        <div className="fact-label">이용 채널</div>
                        <div className="fact-val">
                          <div className="btn-row" style={{ gap: 6 }}>
                            {Array.from(selected.channels).map((ch) => (
                              <span key={ch} className="chip gray">
                                {ch}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="fact-item">
                        <div className="fact-label">누적 문의 / 미처리</div>
                        <div className="fact-val">
                          총 {selected.items.length}건
                          {selected.pending > 0 ? ` (미처리 ${selected.pending}건)` : ' (모두 처리됨)'}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="sec" style={{ marginTop: 20 }}>
                  <div className="sec-head">
                    <h2>문의 이력 (시간순)</h2>
                    <span className="row-val">{chronologicalItems.length}건</span>
                  </div>

                  {chronologicalItems.map((it) => {
                    const st = statusChip(it);
                    const tone = scoreTone(it.score, thHold);

                    return (
                      <article key={it.id} className="card">
                        <div className="row" style={{ padding: 0, borderBottom: 'none', marginBottom: 10 }}>
                          <div className="row-body">
                            <div className="row-t1">
                              <span className="chip gray">{it.channel}</span>
                              <span className={`chip ${tone}`}>{it.score}점</span>
                              <span className={`chip ${st.tone}`}>{st.label}</span>
                            </div>
                            <div className="row-t2">
                              {new Date(it.ts).toLocaleString('ko-KR')} ({formatAgo(it.ts)})
                            </div>
                          </div>
                          <Link
                            to={`/inquiries/${encodeURIComponent(it.id)}`}
                            className="btn ghost sm"
                          >
                            상세 ›
                          </Link>
                        </div>

                        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink-2)', marginBottom: 8 }}>
                          {summarizeItem(it)}
                        </div>

                        <div className={`quote ${tone === 'red' ? 'red' : tone === 'gold' ? 'gold' : ''}`}>
                          {it.text}
                        </div>

                        {it.reply && (
                          <div className="detail-block" style={{ marginTop: 10 }}>
                            <div className="detail-block-title">답변 내역</div>
                            <div className="fact-val">{it.reply}</div>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </Layout>
  );
};
