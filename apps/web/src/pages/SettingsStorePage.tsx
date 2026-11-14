import React, { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { PushNotificationCard } from '../components/PushNotificationCard';
import { useApp } from '../context/AppContext';
import { Api } from '../lib/api';
import { CONFIG } from '../lib/config';
import type { ContextDoc, FaqItem, StoreFieldConfig } from '../lib/types';

const DOC_KINDS: Array<{ kind: string; label: string; desc: string }> = [
  { kind: 'business', label: '매장 소개 (business)', desc: '매장 특징, 위치, 브랜드 소개 등 기본 정보' },
  { kind: 'offerings', label: '상품 · 메뉴 (offerings)', desc: '판매 상품, 가격, 옵션, 재고 안내' },
  { kind: 'policies', label: '운영 정책 (policies)', desc: '교환·환불·배송·예약 규정' },
];

function getByPath(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function parseContextDocs(res: unknown): Record<string, string> {
  const map: Record<string, string> = { business: '', offerings: '', policies: '' };
  if (!res) return map;
  if (Array.isArray(res)) {
    for (const d of res as ContextDoc[]) {
      if (d?.kind) map[d.kind] = d.content_md ?? d.content ?? '';
    }
    return map;
  }
  if (typeof res === 'object') {
    const obj = res as Record<string, unknown>;
    const list = obj.docs ?? obj.context_docs ?? obj.items;
    if (Array.isArray(list)) {
      for (const d of list as ContextDoc[]) {
        if (d?.kind) map[d.kind] = d.content_md ?? d.content ?? '';
      }
      return map;
    }
    for (const k of ['business', 'offerings', 'policies']) {
      const val = obj[k];
      if (typeof val === 'string') map[k] = val;
      else if (val && typeof val === 'object') {
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

export const SettingsStorePage: React.FC = () => {
  const { data, setStoreField, resetStoreSection, showToast } = useApp();
  const [searchParams] = useSearchParams();

  const requestedSection = searchParams.get('s') || 'response';
  const activeSec =
    CONFIG.storeSettings.sections.find((sec) => sec.id === requestedSection) ||
    CONFIG.storeSettings.sections[0];

  // Local draft overrides for text/number/textarea inputs
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [resetting, setResetting] = useState(false);

  // Knowledge section state
  const [docs, setDocs] = useState<Record<string, string>>({
    business: '',
    offerings: '',
    policies: '',
  });
  const [faqs, setFaqs] = useState<FaqItem[]>([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [newQuestion, setNewQuestion] = useState('');
  const [newAnswer, setNewAnswer] = useState('');
  const [faqBusy, setFaqBusy] = useState(false);

  const loadKnowledge = useCallback(async () => {
    if (!Api.token()) return;
    setKnowledgeLoading(true);
    try {
      const [docsRes, faqsRes] = await Promise.allSettled([Api.contextDocs(), Api.faqs()]);
      if (docsRes.status === 'fulfilled') {
        setDocs(parseContextDocs(docsRes.value));
      }
      if (faqsRes.status === 'fulfilled') {
        setFaqs(parseFaqs(faqsRes.value));
      }
    } finally {
      setKnowledgeLoading(false);
    }
  }, []);

  useEffect(() => {
    loadKnowledge();
  }, [loadKnowledge]);

  const draftKey = (path: string) => `${activeSec.id}:${path}`;

  const clearDraftKey = (path: string) => {
    const k = draftKey(path);
    setDrafts((prev) => {
      if (!(k in prev)) return prev;
      const next = { ...prev };
      delete next[k];
      return next;
    });
  };

  const handleResetSection = async () => {
    setResetting(true);
    try {
      await resetStoreSection(activeSec.id);
      setDrafts((prev) => {
        const prefix = `${activeSec.id}:`;
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (!k.startsWith(prefix)) next[k] = v;
        }
        return next;
      });
    } finally {
      setResetting(false);
    }
  };

  const handleSaveDoc = async (kind: string) => {
    try {
      await Api.putContextDoc(kind, docs[kind] ?? '');
      showToast('매장 문서를 저장했습니다');
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : '문서 저장 실패');
    }
  };

  const handleDeleteDoc = async (kind: string) => {
    try {
      await Api.deleteContextDoc(kind);
      const docsRes = await Api.contextDocs();
      setDocs(parseContextDocs(docsRes));
      showToast('기본값으로 복원했습니다');
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : '복원 실패');
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
      const faqsRes = await Api.faqs();
      setFaqs(parseFaqs(faqsRes));
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
      setFaqs((prev) => prev.map((f) => (f.id === faq.id ? { ...f, is_active: nextActive } : f)));
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

  const sectionData = (data.store[activeSec.id] || {}) as Record<string, unknown>;
  const fields: StoreFieldConfig[] = CONFIG.storeSettings.fields[activeSec.id] || [];

  const renderField = (f: StoreFieldConfig) => {
    const rawVal = getByPath(sectionData, f.path);

    if (f.type === 'toggle') {
      return (
        <div key={f.path} className="row" style={{ paddingLeft: 0, paddingRight: 0 }}>
          <div className="row-body">
            <div className="row-t1">
              <code>{f.path}</code>
            </div>
            {f.desc && <div className="row-t2">{f.desc}</div>}
          </div>
          <label className="sw-wrap">
            <input
              type="checkbox"
              className="sw-input"
              checked={Boolean(rawVal)}
              onChange={(e) => setStoreField(activeSec.id, f.path, e.target.checked)}
            />
            <span className="sw-track" />
          </label>
        </div>
      );
    }

    if (f.type === 'select') {
      return (
        <div key={f.path} className="field">
          <label className="label" htmlFor={`field-${f.path}`}>
            <code>{f.path}</code>
          </label>
          <select
            id={`field-${f.path}`}
            className="select"
            value={String(rawVal ?? '')}
            onChange={(e) => setStoreField(activeSec.id, f.path, e.target.value)}
          >
            {(f.options || []).map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {f.desc && <div className="hint">{f.desc}</div>}
        </div>
      );
    }

    if (f.type === 'number') {
      const k = draftKey(f.path);
      const displayVal = k in drafts ? drafts[k] : rawVal === null || rawVal === undefined ? '' : String(rawVal);

      const commitNumber = () => {
        if (!(k in drafts)) return;
        const trimmed = drafts[k].trim();
        clearDraftKey(f.path);
        if (trimmed === '') {
          setStoreField(activeSec.id, f.path, null);
          return;
        }
        const num = Number(trimmed);
        if (!Number.isNaN(num)) {
          setStoreField(activeSec.id, f.path, num);
        }
      };

      return (
        <div key={f.path} className="field">
          <label className="label" htmlFor={`field-${f.path}`}>
            <code>{f.path}</code> {f.unit ? `(${f.unit})` : ''}
          </label>
          <input
            id={`field-${f.path}`}
            type="number"
            className="input"
            min={f.min}
            max={f.max}
            step={f.step ?? 'any'}
            placeholder={f.placeholder}
            value={displayVal}
            onChange={(e) => setDrafts((prev) => ({ ...prev, [k]: e.target.value }))}
            onBlur={commitNumber}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              }
            }}
          />
          {f.desc && <div className="hint">{f.desc}</div>}
        </div>
      );
    }

    if (f.type === 'text') {
      const k = draftKey(f.path);
      const displayVal = k in drafts ? drafts[k] : String(rawVal ?? '');

      const commitText = () => {
        if (!(k in drafts)) return;
        const val = drafts[k];
        clearDraftKey(f.path);
        setStoreField(activeSec.id, f.path, val);
      };

      return (
        <div key={f.path} className="field">
          <label className="label" htmlFor={`field-${f.path}`}>
            <code>{f.path}</code>
          </label>
          <input
            id={`field-${f.path}`}
            type="text"
            className="input"
            readOnly={f.readonly}
            placeholder={f.placeholder}
            value={displayVal}
            onChange={(e) => setDrafts((prev) => ({ ...prev, [k]: e.target.value }))}
            onBlur={commitText}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              }
            }}
          />
          {f.desc && <div className="hint">{f.desc}</div>}
        </div>
      );
    }

    if (f.type === 'textarea') {
      const k = draftKey(f.path);
      const baseText = f.lines
        ? Array.isArray(rawVal)
          ? rawVal.join('\n')
          : ''
        : String(rawVal ?? '');
      const displayVal = k in drafts ? drafts[k] : baseText;

      const commitTextarea = () => {
        if (!(k in drafts)) return;
        const val = drafts[k];
        clearDraftKey(f.path);
        if (f.lines) {
          const lines = val
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean);
          setStoreField(activeSec.id, f.path, lines);
        } else {
          setStoreField(activeSec.id, f.path, val);
        }
      };

      return (
        <div key={f.path} className="field">
          <label className="label" htmlFor={`field-${f.path}`}>
            <code>{f.path}</code>
          </label>
          <textarea
            id={`field-${f.path}`}
            className="textarea"
            placeholder={f.placeholder}
            value={displayVal}
            onChange={(e) => setDrafts((prev) => ({ ...prev, [k]: e.target.value }))}
            onBlur={commitTextarea}
          />
          {f.desc && <div className="hint">{f.desc}</div>}
        </div>
      );
    }

    if (f.type === 'group') {
      const groupObj = (rawVal && typeof rawVal === 'object' ? rawVal : {}) as Record<string, unknown>;
      return (
        <div key={f.path} className="detail-block" style={{ marginBottom: 14 }}>
          <div className="detail-block-title">
            <code>{f.path}</code>
          </div>
          {f.desc && (
            <div className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
              {f.desc}
            </div>
          )}
          <div className="set-row">
            {(f.children || []).map((child) => {
              const childPath = `${f.path}.${child.key}`;
              const childVal = groupObj[child.key];

              if (child.type === 'toggle') {
                return (
                  <label
                    key={child.key}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      padding: '8px 12px',
                      background: 'var(--panel)',
                      border: '1px solid var(--line)',
                      borderRadius: 'var(--r-s)',
                      cursor: 'pointer',
                    }}
                  >
                    <code>{child.key}</code>
                    <span className="sw-wrap">
                      <input
                        type="checkbox"
                        className="sw-input"
                        checked={Boolean(childVal)}
                        onChange={(e) => setStoreField(activeSec.id, childPath, e.target.checked)}
                      />
                      <span className="sw-track" />
                    </span>
                  </label>
                );
              }

              if (child.type === 'number') {
                const ck = draftKey(childPath);
                const cDisplay =
                  ck in drafts
                    ? drafts[ck]
                    : childVal === null || childVal === undefined
                    ? ''
                    : String(childVal);

                return (
                  <div key={child.key} className="field" style={{ marginBottom: 0 }}>
                    <label className="label" htmlFor={`field-${childPath}`}>
                      <code>{child.key}</code>
                    </label>
                    <input
                      id={`field-${childPath}`}
                      type="number"
                      className="input"
                      min={child.min}
                      max={child.max}
                      value={cDisplay}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [ck]: e.target.value }))}
                      onBlur={() => {
                        if (!(ck in drafts)) return;
                        const num = Number(drafts[ck]);
                        clearDraftKey(childPath);
                        if (!Number.isNaN(num)) setStoreField(activeSec.id, childPath, num);
                      }}
                    />
                  </div>
                );
              }

              const ck = draftKey(childPath);
              const cDisplay = ck in drafts ? drafts[ck] : String(childVal ?? '');
              return (
                <div key={child.key} className="field" style={{ marginBottom: 0 }}>
                  <label className="label" htmlFor={`field-${childPath}`}>
                    <code>{child.key}</code>
                  </label>
                  <input
                    id={`field-${childPath}`}
                    type="text"
                    className="input"
                    value={cDisplay}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [ck]: e.target.value }))}
                    onBlur={() => {
                      if (!(ck in drafts)) return;
                      const val = drafts[ck];
                      clearDraftKey(childPath);
                      setStoreField(activeSec.id, childPath, val);
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    if (f.type === 'weekly') {
      const weeklyObj = (rawVal && typeof rawVal === 'object' ? rawVal : {}) as Record<
        string,
        { open: string | null; close: string | null }
      >;
      return (
        <div key={f.path} className="field">
          <div className="label">
            <code>{f.path}</code>
          </div>
          {f.desc && (
            <div className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
              {f.desc}
            </div>
          )}
          <div className="list">
            {CONFIG.storeSettings.days.map((day) => {
              const slot = weeklyObj[day.key] || { open: null, close: null };
              const isOpen = Boolean(slot.open && slot.close);
              const dayPath = `${f.path}.${day.key}`;

              return (
                <div key={day.key} className="row" style={{ flexWrap: 'wrap' }}>
                  <strong style={{ width: 28 }}>{day.label}</strong>
                  <label className="sw-wrap">
                    <input
                      type="checkbox"
                      className="sw-input"
                      checked={isOpen}
                      onChange={(e) =>
                        setStoreField(
                          activeSec.id,
                          dayPath,
                          e.target.checked
                            ? { open: slot.open || '10:00', close: slot.close || '19:00' }
                            : { open: null, close: null }
                        )
                      }
                    />
                    <span className="sw-track" />
                  </label>
                  {isOpen ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 200 }}>
                      <input
                        type="time"
                        className="input"
                        style={{ padding: '6px 10px' }}
                        value={slot.open || '10:00'}
                        onChange={(e) =>
                          setStoreField(activeSec.id, dayPath, {
                            open: e.target.value,
                            close: slot.close || '19:00',
                          })
                        }
                      />
                      <span>~</span>
                      <input
                        type="time"
                        className="input"
                        style={{ padding: '6px 10px' }}
                        value={slot.close || '19:00'}
                        onChange={(e) =>
                          setStoreField(activeSec.id, dayPath, {
                            open: slot.open || '10:00',
                            close: e.target.value,
                          })
                        }
                      />
                    </div>
                  ) : (
                    <span className="chip gray">휴무</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <Layout title="매장 설정" subtitle="서버 연동 AI·영업·지식 설정" backTo="/settings">
      <div className="split">
        {/* 좌측 섹션 레일 */}
        <nav aria-label="매장 설정 섹션" className="list">
          {CONFIG.storeSettings.sections.map((s) => {
            const isCurrent = s.id === activeSec.id;
            return (
              <Link
                key={s.id}
                to={`/settings/store?s=${s.id}`}
                className="row"
                style={{
                  background: isCurrent ? 'var(--soft)' : undefined,
                  fontWeight: isCurrent ? 700 : undefined,
                }}
              >
                <span aria-hidden="true" style={{ fontSize: 18 }}>
                  {s.icon}
                </span>
                <div className="row-body">
                  <div className="row-t1">{s.label}</div>
                </div>
                {isCurrent && <span className="chip solid">선택</span>}
              </Link>
            );
          })}
        </nav>

        {/* 우측 섹션 본문 */}
        <div>
          <div className="card" style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 700 }}>
                  {activeSec.icon} {activeSec.label}
                </h2>
                <p className="row-t2">{activeSec.note}</p>
              </div>
              {activeSec.id !== 'knowledge' && (
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={resetting}
                  onClick={handleResetSection}
                >
                  {resetting ? '복원 중...' : '기본값 복원'}
                </button>
              )}
            </div>
          </div>

          {activeSec.id === 'knowledge' ? (
            <>
              <section className="sec">
                <div className="sec-head">
                  <h2>매장 지식 문서</h2>
                </div>
                {knowledgeLoading && <div className="note">불러오는 중...</div>}
                {DOC_KINDS.map((d) => (
                  <div key={d.kind} className="card">
                    <div className="field">
                      <label className="label" htmlFor={`doc-${d.kind}`}>
                        {d.label}
                      </label>
                      <div className="hint" style={{ marginTop: 0, marginBottom: 8 }}>
                        {d.desc}
                      </div>
                      <textarea
                        id={`doc-${d.kind}`}
                        className="textarea"
                        style={{ minHeight: 130 }}
                        value={docs[d.kind] ?? ''}
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
                        onClick={() => handleSaveDoc(d.kind)}
                      >
                        저장
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => handleDeleteDoc(d.kind)}
                      >
                        기본값으로 복원
                      </button>
                    </div>
                  </div>
                ))}
              </section>

              <section className="sec">
                <div className="sec-head">
                  <h2>자주 묻는 질문 (FAQ)</h2>
                </div>

                <form className="card" onSubmit={handleCreateFaq} style={{ marginBottom: 14 }}>
                  <div className="field">
                    <label className="label" htmlFor="faq-q">
                      새 질문
                    </label>
                    <input
                      id="faq-q"
                      type="text"
                      className="input"
                      placeholder="예: 주차 가능한가요?"
                      value={newQuestion}
                      onChange={(e) => setNewQuestion(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="faq-a">
                      답변
                    </label>
                    <textarea
                      id="faq-a"
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
                            <label className="sw-wrap" title="활성화 전환">
                              <input
                                type="checkbox"
                                className="sw-input"
                                checked={active}
                                onChange={() => handleToggleFaq(faq)}
                              />
                              <span className="sw-track" />
                            </label>
                            <button
                              type="button"
                              className="btn danger sm"
                              onClick={() => handleDeleteFaq(faq.id)}
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
            </>
          ) : (
            <>
              <div className="card">{fields.map((f) => renderField(f))}</div>
              {activeSec.id === 'notifications' && (
                <div style={{ marginTop: 14 }}>
                  <PushNotificationCard />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Layout>
  );
};
