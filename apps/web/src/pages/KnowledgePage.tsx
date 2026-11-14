import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { useApp } from '../context/AppContext';
import { Api } from '../lib/api';
import { CONFIG, bizTypeOf } from '../lib/config';
import type { ContextDoc, FaqItem } from '../lib/types';

type DocKind = 'business' | 'offerings' | 'policies';

const DOC_KINDS: ReadonlyArray<{ kind: DocKind; title: string; desc: string }> = [
  {
    kind: 'business',
    title: '매장 소개 · 영업 안내',
    desc: '매장 특징, 위치, 주차, 매장 분위기 등 기본 안내 정보',
  },
  {
    kind: 'offerings',
    title: '상품 · 서비스 카탈로그',
    desc: '판매 상품, 메뉴, 가격, 옵션, 재고 및 이용 방법 안내',
  },
  {
    kind: 'policies',
    title: '교환 · 환불 · 운영 정책',
    desc: '교환·환불 기준, 배송, 예약 변경 및 취소 규정',
  },
];

const DAY_ORDER: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'mon', label: '월' },
  { key: 'tue', label: '화' },
  { key: 'wed', label: '수' },
  { key: 'thu', label: '목' },
  { key: 'fri', label: '금' },
  { key: 'sat', label: '토' },
  { key: 'sun', label: '일' },
];

function formatWeeklyHours(
  weekly: Record<string, { open: string | null; close: string | null }> | undefined
): string {
  if (!weekly) return '미설정';

  const groups: Array<{ labels: string[]; text: string }> = [];
  for (const { key, label } of DAY_ORDER) {
    const slot = weekly[key];
    const text =
      slot && slot.open && slot.close ? `${slot.open} ~ ${slot.close}` : '휴무';
    const prev = groups[groups.length - 1];
    if (prev && prev.text === text) {
      prev.labels.push(label);
    } else {
      groups.push({ labels: [label], text });
    }
  }

  return groups
    .map((g) => {
      const dayRange =
        g.labels.length >= 3
          ? `${g.labels[0]}~${g.labels[g.labels.length - 1]}`
          : g.labels.join('·');
      return `${dayRange} ${g.text}`;
    })
    .join(' / ');
}

function parseContextDocs(res: unknown): Record<DocKind, string> {
  const map: Record<DocKind, string> = { business: '', offerings: '', policies: '' };
  if (!res) return map;

  const assignList = (list: ContextDoc[]) => {
    for (const d of list) {
      if (d?.kind === 'business' || d?.kind === 'offerings' || d?.kind === 'policies') {
        map[d.kind] = d.content_md ?? d.content ?? '';
      }
    }
  };

  if (Array.isArray(res)) {
    assignList(res as ContextDoc[]);
    return map;
  }

  if (typeof res === 'object') {
    const obj = res as Record<string, unknown>;
    const list = obj.docs ?? obj.context_docs ?? obj.items;
    if (Array.isArray(list)) {
      assignList(list as ContextDoc[]);
      return map;
    }
    for (const k of ['business', 'offerings', 'policies'] as const) {
      const val = obj[k];
      if (typeof val === 'string') {
        map[k] = val;
      } else if (val && typeof val === 'object') {
        const doc = val as ContextDoc;
        map[k] = doc.content_md ?? doc.content ?? '';
      }
    }
  }
  return map;
}

function parseFaqs(res: unknown): FaqItem[] {
  if (Array.isArray(res)) return res as FaqItem[];
  if (res && typeof res === 'object') {
    const obj = res as Record<string, unknown>;
    const list = obj.faqs ?? obj.items;
    if (Array.isArray(list)) return list as FaqItem[];
  }
  return [];
}

export const KnowledgePage: React.FC = () => {
  const { data, showToast } = useApp();

  const [docs, setDocs] = useState<Record<DocKind, string>>({
    business: '',
    offerings: '',
    policies: '',
  });
  const [docsLoading, setDocsLoading] = useState(false);
  const [savingDoc, setSavingDoc] = useState<DocKind | null>(null);
  const [restoringDoc, setRestoringDoc] = useState<DocKind | null>(null);

  const [faqs, setFaqs] = useState<FaqItem[]>([]);
  const [faqsLoading, setFaqsLoading] = useState(false);
  const [newQuestion, setNewQuestion] = useState('');
  const [newAnswer, setNewAnswer] = useState('');
  const [faqBusy, setFaqBusy] = useState(false);

  const loadDocs = useCallback(async () => {
    if (!Api.token()) return;
    setDocsLoading(true);
    try {
      const res = await Api.contextDocs();
      setDocs(parseContextDocs(res));
    } catch {
      // keep existing state on transient error
    } finally {
      setDocsLoading(false);
    }
  }, []);

  const loadFaqs = useCallback(async () => {
    if (!Api.token()) return;
    setFaqsLoading(true);
    try {
      const res = await Api.faqs();
      setFaqs(parseFaqs(res));
    } catch {
      // keep existing state on transient error
    } finally {
      setFaqsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDocs();
    void loadFaqs();
  }, [loadDocs, loadFaqs]);

  const handleSaveDoc = async (kind: DocKind) => {
    setSavingDoc(kind);
    try {
      await Api.putContextDoc(kind, docs[kind] ?? '');
      showToast('매장 문서를 저장했습니다');
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : '문서 저장 실패');
    } finally {
      setSavingDoc(null);
    }
  };

  const handleRestoreDoc = async (kind: DocKind) => {
    setRestoringDoc(kind);
    try {
      await Api.deleteContextDoc(kind);
      const res = await Api.contextDocs();
      setDocs(parseContextDocs(res));
      showToast('기본값으로 복원했습니다');
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : '복원 실패');
    } finally {
      setRestoringDoc(null);
    }
  };

  const handleCreateFaq = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newQuestion.trim() || !newAnswer.trim()) {
      showToast('질문과 답변을 모두 입력해 주세요');
      return;
    }
    setFaqBusy(true);
    try {
      await Api.createFaq(newQuestion.trim(), newAnswer.trim());
      setNewQuestion('');
      setNewAnswer('');
      const res = await Api.faqs();
      setFaqs(parseFaqs(res));
      showToast('FAQ를 추가했습니다');
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'FAQ 추가 실패');
    } finally {
      setFaqBusy(false);
    }
  };

  const handleToggleFaq = async (faq: FaqItem) => {
    const nextActive = !(faq.is_active ?? true);
    try {
      await Api.patchFaq(faq.id, { is_active: nextActive });
      setFaqs((prev) =>
        prev.map((f) => (f.id === faq.id ? { ...f, is_active: nextActive } : f))
      );
      showToast(nextActive ? 'FAQ를 활성화했습니다' : 'FAQ를 비활성화했습니다');
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : '상태 변경 실패');
    }
  };

  const handleDeleteFaq = async (id: string) => {
    try {
      await Api.deleteFaq(id);
      setFaqs((prev) => prev.filter((f) => f.id !== id));
      showToast('FAQ를 삭제했습니다');
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'FAQ 삭제 실패');
    }
  };

  const storeName = data.settings.storeName || CONFIG.brand.owner;
  const biz = bizTypeOf(data.settings.bizType);
  const assistantName = data.store.persona?.assistant_name || CONFIG.defaults.agent;
  const weeklyHoursText = useMemo(
    () => formatWeeklyHours(data.store.hours?.weekly),
    [data.store.hours?.weekly]
  );

  return (
    <Layout
      title="매장 지식 (RAG)"
      subtitle="AI가 답변 근거로 참고하는 매장 정보 · 문서 · FAQ"
    >
      <section className="sec" aria-label="AI가 참고하는 기본 매장 정보">
        <div className="sec-head">
          <h2>AI가 참고하는 기본 매장 정보</h2>
          <Link className="more" to="/settings/store?s=hours">
            영업시간 수정 ›
          </Link>
        </div>

        <div className="card">
          <div className="fact-grid" style={{ marginBottom: 14 }}>
            <div className="fact-item">
              <div className="fact-label">매장명</div>
              <div className="fact-val">{storeName}</div>
            </div>
            <div className="fact-item">
              <div className="fact-label">업종</div>
              <div className="fact-val">
                {biz.icon} {biz.label}
              </div>
            </div>
            <div className="fact-item">
              <div className="fact-label">AI 이름</div>
              <div className="fact-val">{assistantName}</div>
            </div>
            <div className="fact-item">
              <div className="fact-label">고객센터 운영시간</div>
              <div className="fact-val">{weeklyHoursText}</div>
            </div>
          </div>

          <div className="note blue">
            AI는 아래 <strong>매장 지식 문서 3종</strong>과 <strong>자주 묻는 질문(FAQ)</strong>을
            RAG로 검색해 고객에게 답변합니다.
          </div>
        </div>
      </section>

      <section className="sec" aria-label="매장 지식 문서">
        <div className="sec-head">
          <h2>매장 지식 문서</h2>
          {docsLoading && <span className="chip gray">불러오는 중...</span>}
        </div>

        {DOC_KINDS.map((d) => {
          const content = docs[d.kind] ?? '';
          const isSaving = savingDoc === d.kind;
          const isRestoring = restoringDoc === d.kind;
          const busy = isSaving || isRestoring;

          return (
            <div key={d.kind} className="card">
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  flexWrap: 'wrap',
                  marginBottom: 6,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <label
                    htmlFor={`knowledge-doc-${d.kind}`}
                    style={{ fontSize: 15.5, fontWeight: 700, color: 'var(--ink)' }}
                  >
                    {d.title}
                  </label>
                  <span className="chip blue">{d.kind}</span>
                </div>
                <span className="chip gray">{content.length.toLocaleString()}자</span>
              </div>

              <div className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
                {d.desc}
              </div>

              <div className="field">
                <textarea
                  id={`knowledge-doc-${d.kind}`}
                  className="textarea"
                  style={{ minHeight: 150 }}
                  value={content}
                  onChange={(e) =>
                    setDocs((prev) => ({
                      ...prev,
                      [d.kind]: e.target.value,
                    }))
                  }
                />
              </div>

              <div className="btn-row">
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy}
                  onClick={() => void handleSaveDoc(d.kind)}
                >
                  {isSaving ? '저장 중...' : '저장'}
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={busy}
                  onClick={() => void handleRestoreDoc(d.kind)}
                >
                  {isRestoring ? '복원 중...' : '기본값 복원'}
                </button>
              </div>
            </div>
          );
        })}
      </section>

      <section className="sec" aria-label="자주 묻는 질문 (FAQ)">
        <div className="sec-head">
          <h2>자주 묻는 질문 (FAQ)</h2>
          <span className="chip gray">
            {faqsLoading ? '불러오는 중...' : `${faqs.length}건`}
          </span>
        </div>

        <form className="card" onSubmit={handleCreateFaq} style={{ marginBottom: 14 }}>
          <div className="field">
            <label className="label" htmlFor="knowledge-faq-q">
              질문
            </label>
            <input
              id="knowledge-faq-q"
              type="text"
              className="input"
              placeholder="예: 주차 가능한가요?"
              value={newQuestion}
              onChange={(e) => setNewQuestion(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="knowledge-faq-a">
              답변
            </label>
            <textarea
              id="knowledge-faq-a"
              className="textarea"
              placeholder="예: 건물 뒤편 전용 주차장에 2시간 무료 주차 가능합니다."
              value={newAnswer}
              onChange={(e) => setNewAnswer(e.target.value)}
            />
          </div>
          <button type="submit" className="btn sm" disabled={faqBusy}>
            {faqBusy ? '추가 중...' : 'FAQ 추가'}
          </button>
        </form>

        {faqs.length === 0 ? (
          <div className="empty">
            <div className="empty-ico">📚</div>
            <div className="empty-t">등록된 FAQ가 없습니다</div>
            <div className="empty-d">자주 묻는 질문을 추가하면 AI가 우선 참조합니다.</div>
          </div>
        ) : (
          <div className="list">
            {faqs.map((faq) => {
              const active = faq.is_active ?? true;
              return (
                <div key={faq.id} className="row" style={{ alignItems: 'flex-start' }}>
                  <div className="row-body">
                    <div className="row-t1">
                      <span>{faq.question}</span>
                      <span className={`chip ${active ? 'green' : 'gray'}`}>
                        {active ? '사용 중' : '비활성'}
                      </span>
                    </div>
                    <div className="row-t2" style={{ whiteSpace: 'pre-wrap' }}>
                      {faq.answer}
                    </div>
                  </div>
                  <div className="btn-row" style={{ flexShrink: 0 }}>
                    <label className="sw-wrap" title={active ? '비활성화' : '활성화'}>
                      <input
                        type="checkbox"
                        className="sw-input"
                        checked={active}
                        onChange={() => void handleToggleFaq(faq)}
                      />
                      <span className="sw-track" />
                    </label>
                    <button
                      type="button"
                      className="btn danger sm"
                      onClick={() => void handleDeleteFaq(faq.id)}
                    >
                      삭제
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </Layout>
  );
};
