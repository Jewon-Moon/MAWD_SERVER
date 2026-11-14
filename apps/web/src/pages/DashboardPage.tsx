import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { useApp } from '../context/AppContext';
import { CONFIG } from '../lib/config';
import { computeUrgency, formatAgo, normalizePerson, summarizeItem, topicOf } from '../lib/judge';

const QUICK_LINKS = [
  { to: '/inquiries', icon: '📋', title: '문의 목록', desc: '답변할 문의와 처리 완료 내역 확인' },
  { to: '/sns', icon: '📷', title: 'SNS 댓글 관리', desc: '인스타그램 악성 댓글 숨김 · 답글 설정' },
  { to: '/channels', icon: '💬', title: '채널 · 연동', desc: '채널톡, 쇼핑몰·배달 플랫폼 연결 관리' },
  { to: '/knowledge', icon: '📚', title: '매장 지식 (RAG)', desc: 'AI가 참고하는 매장 정보 · 문서 · FAQ 관리' },
  { to: '/demo', icon: '📞', title: '통화 기록', desc: '접수된 고객 통화 요약 및 대화 기록 확인' },
  { to: '/test', icon: '🧪', title: '고객 시연 (전화 · 채팅 테스트)', desc: '실시간 AI 응대와 위험 감지를 직접 체험' },
  { to: '/settings', icon: '⚙️', title: '매장 설정', desc: '응대 정책, 말투, 영업시간, 매장 지식 관리' },
] as const;

export const DashboardPage: React.FC = () => {
  const { data } = useApp();

  const { pending, totalCount, autoCount, urgentCount } = useMemo(() => {
    const pendingList = data.items
      .filter((it) => !it.handled)
      .sort((a, b) => b.ts - a.ts);
    const auto = data.items.filter((it) => it.handled === 'auto').length;
    const urgent = pendingList.filter((it) => computeUrgency(it).label === '긴급').length;

    return {
      pending: pendingList,
      totalCount: data.items.length,
      autoCount: auto,
      urgentCount: urgent,
    };
  }, [data.items]);

  const topPending = pending.slice(0, 3);
  const storeName = data.settings.storeName || CONFIG.brand.owner;

  return (
    <Layout title="홈" subtitle={`${storeName} · 오늘의 응대 현황`}>
      <section className="sec" aria-label="핵심 지표">
        <div className="stats">
          <div className="stat">
            <div className="stat-n">{pending.length}</div>
            <div className="stat-l">답변할 문의</div>
          </div>
          <div className="stat">
            <div className="stat-n">{totalCount}</div>
            <div className="stat-l">오늘 접수</div>
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
          <h2>답변할 문의</h2>
          <Link className="more" to="/inquiries">
            전체 보기 ›
          </Link>
        </div>

        {topPending.length === 0 ? (
          <div className="empty">
            <div className="empty-ico">✨</div>
            <div className="empty-t">모든 문의를 처리했어요</div>
            <div className="empty-d">새로운 보류 문의가 접수되면 이곳에 표시됩니다.</div>
          </div>
        ) : (
          <div className="list">
            {topPending.map((it) => {
              const person = normalizePerson(it.customer);
              const topic = topicOf(it.topic);
              const categoryLabel = it.category || topic?.name;
              const heatTone = it.score >= 70 ? 'red' : it.score >= 40 ? 'gold' : 'gray';

              return (
                <Link
                  key={it.id}
                  to={`/inquiries/${encodeURIComponent(it.id)}`}
                  className="row"
                >
                  <div className="row-body">
                    <div className="row-t1">
                      <span className="chip gray">{it.channel}</span>
                      {categoryLabel && <span className="chip blue">{categoryLabel}</span>}
                      <span>{person.label}</span>
                      <span className={`chip ${heatTone}`}>
                        {it.heatLabel ? `${it.score}점 · ${it.heatLabel}` : `${it.score}점`}
                      </span>
                    </div>
                    <div className="row-t2">{summarizeItem(it)}</div>
                  </div>
                  <div className="row-val">{formatAgo(it.ts)}</div>
                  <span className="chev" aria-hidden="true">
                    ›
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      <section className="sec">
        <div className="sec-head">
          <h2>매장 한눈에 보기</h2>
        </div>

        <div className="list">
          {QUICK_LINKS.map((item) => (
            <Link key={item.to} to={item.to} className="row">
              <div className="ico-box" aria-hidden="true">
                {item.icon}
              </div>
              <div className="row-body">
                <div className="row-t1">{item.title}</div>
                <div className="row-t2">{item.desc}</div>
              </div>
              <span className="chev" aria-hidden="true">
                ›
              </span>
            </Link>
          ))}
        </div>
      </section>
    </Layout>
  );
};
