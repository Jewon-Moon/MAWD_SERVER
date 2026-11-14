import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { Api } from '../lib/api';
import { CONFIG, bizTypeOf } from '../lib/config';
import type { BizTypeId, PlatformConfig } from '../lib/types';

const STEPS = [
  '1. 플랫폼 선택',
  '2. 플랫폼 연결',
  '3. 업종 선택',
  '4. 채널톡 & 완료',
] as const;

export const OnboardingPage: React.FC = () => {
  const { data, connectPlatform, applyMe, setLocalSettings, showToast } = useApp();
  const navigate = useNavigate();

  const [step, setStep] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    (data.settings.platforms || []).filter((p) => p.connected).map((p) => p.id)
  );
  const [credentials, setCredentials] = useState<Record<string, Record<string, string>>>({});
  const [connectedMode, setConnectedMode] = useState<Record<string, 'api' | 'demo'>>({});
  const [connectBusy, setConnectBusy] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<Record<string, string>>({});

  const recommendedBizType = useMemo<BizTypeId>(() => {
    for (const id of selectedIds) {
      const p = CONFIG.platforms.find((item) => item.id === id);
      if (p) {
        return CONFIG.platformKinds[p.kind].bizType;
      }
    }
    return data.settings.bizType || 'food';
  }, [selectedIds, data.settings.bizType]);

  const [bizType, setBizType] = useState<BizTypeId>(data.settings.bizType || 'food');
  const [bizManuallyPicked, setBizManuallyPicked] = useState(false);
  const [storeName, setStoreName] = useState(data.settings.storeName || '');
  const [ctKey, setCtKey] = useState('');
  const [ctSecret, setCtSecret] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const selectedPlatforms = useMemo<PlatformConfig[]>(
    () => CONFIG.platforms.filter((p) => selectedIds.includes(p.id)),
    [selectedIds]
  );

  const togglePlatform = (id: string) => {
    const exists = selectedIds.includes(id);
    const next = exists ? selectedIds.filter((x) => x !== id) : [...selectedIds, id];
    setSelectedIds(next);
    connectPlatform(id, !exists);
  };

  const updateCred = (platformId: string, fieldKey: string, val: string) => {
    setCredentials((prev) => ({
      ...prev,
      [platformId]: {
        ...(prev[platformId] || {}),
        [fieldKey]: val,
      },
    }));
  };

  const handleConnectPlatform = async (p: PlatformConfig, mode: 'api' | 'demo') => {
    setConnectBusy(p.id);
    setConnectError((prev) => ({ ...prev, [p.id]: '' }));

    try {
      if (mode === 'api') {
        const creds = credentials[p.id] || {};
        const fields = p.connect.fields || [];
        for (const f of fields) {
          const val = (creds[f.key] || '').trim();
          if (!val || (f.min && val.length < f.min)) {
            throw new Error(`${f.label}을(를) 올바르게 입력해 주세요.`);
          }
        }
        await Api.connectCommerce(p.apiSource, { mode: 'api', credentials: creds });
      } else {
        await Api.connectCommerce(p.apiSource, { mode: 'demo' });
      }
      setConnectedMode((prev) => ({ ...prev, [p.id]: mode }));
      connectPlatform(p.id, true);
      showToast(`${p.name} 연결이 완료되었습니다`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '연결에 실패했습니다.';
      setConnectError((prev) => ({ ...prev, [p.id]: msg }));
    } finally {
      setConnectBusy(null);
    }
  };

  const goToStep = (nextStep: number) => {
    if (nextStep === 2 && !bizManuallyPicked) {
      setBizType(recommendedBizType);
    }
    setSubmitError('');
    setStep(nextStep);
  };

  const handleFinish = async () => {
    setSubmitting(true);
    setSubmitError('');

    try {
      const biz = bizTypeOf(bizType);
      const body: {
        template: string;
        store_name?: string;
        channeltalk?: { access_key: string; access_secret: string };
      } = {
        template: biz.template,
      };
      const trimmedStore = storeName.trim();
      if (trimmedStore) body.store_name = trimmedStore;
      if (ctKey.trim() && ctSecret.trim()) {
        body.channeltalk = {
          access_key: ctKey.trim(),
          access_secret: ctSecret.trim(),
        };
      }

      await Api.applyOnboarding(body);
      const me = await Api.me();
      applyMe(me);
      setLocalSettings({
        onboarded: true,
        bizType,
        storeName: trimmedStore || data.settings.storeName,
      });
      showToast('초기 설정이 완료되었습니다');
      navigate('/', { replace: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '설정 저장에 실패했습니다.';
      setSubmitError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card" style={{ maxWidth: 560 }}>
        <div style={{ marginBottom: 20 }}>
          <div className="eyebrow">초기 설정 · {step + 1} / {STEPS.length}</div>
          <h1 style={{ fontSize: 21, fontWeight: 800, letterSpacing: '-0.4px' }}>{STEPS[step]}</h1>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 6,
              marginTop: 14,
            }}
            aria-label="진행 단계"
          >
            {STEPS.map((label, idx) => (
              <div
                key={label}
                style={{
                  height: 5,
                  borderRadius: 999,
                  background: idx <= step ? 'var(--ink)' : 'var(--line)',
                  transition: 'background 0.2s ease',
                }}
                title={label}
              />
            ))}
          </div>
        </div>

        {step === 0 && (
          <div>
            <p className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
              운영 중인 판매·배달 플랫폼을 모두 선택해 주세요. 나중에 설정에서 바꿀 수 있어요.
            </p>
            <div className="list" style={{ marginBottom: 18 }}>
              {CONFIG.platforms.map((p) => {
                const isSelected = selectedIds.includes(p.id);
                const kindLabel = CONFIG.platformKinds[p.kind].label;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className="row"
                    style={{ width: '100%', textAlign: 'left' }}
                    onClick={() => togglePlatform(p.id)}
                  >
                    <div className="ico-box">{p.icon}</div>
                    <div className="row-body">
                      <div className="row-t1">
                        <span>{p.name}</span>
                        <span className="chip gray">{kindLabel}</span>
                      </div>
                    </div>
                    <span className={`chip ${isSelected ? 'solid' : 'gray'}`}>
                      {isSelected ? '선택됨' : '선택'}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={() => goToStep(1)}>
                다음 단계 ›
              </button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div>
            {selectedPlatforms.length === 0 ? (
              <div className="note" style={{ marginBottom: 18 }}>
                선택한 플랫폼이 없습니다. 바로 다음 단계로 넘어가거나 이전 단계에서 플랫폼을 선택해 주세요.
              </div>
            ) : (
              <div style={{ marginBottom: 18 }}>
                {selectedPlatforms.map((p) => {
                  const status = connectedMode[p.id];
                  const busy = connectBusy === p.id;
                  const errMsg = connectError[p.id];
                  const creds = credentials[p.id] || {};

                  return (
                    <div key={p.id} className="card">
                      <div className="row-t1" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span>{p.icon}</span>
                          <span>{p.name}</span>
                        </span>
                        {status && (
                          <span className="chip green">
                            {status === 'api' ? 'API 연결됨' : '데모 연결됨'}
                          </span>
                        )}
                      </div>

                      {p.connect.method === 'api' ? (
                        <div>
                          {p.connect.help && (
                            <p className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
                              {p.connect.help}
                            </p>
                          )}
                          {(p.connect.fields || []).map((f) => (
                            <div key={f.key} className="field">
                              <label className="label" htmlFor={`cred-${p.id}-${f.key}`}>
                                {f.label}
                              </label>
                              <input
                                id={`cred-${p.id}-${f.key}`}
                                type={f.secret ? 'password' : 'text'}
                                className="input"
                                value={creds[f.key] || ''}
                                onChange={(e) => updateCred(p.id, f.key, e.target.value)}
                                disabled={busy}
                              />
                            </div>
                          ))}
                          {errMsg && (
                            <div className="note red" style={{ marginBottom: 12 }}>
                              {errMsg}
                            </div>
                          )}
                          <div className="btn-row">
                            <button
                              type="button"
                              className="btn sm"
                              disabled={busy}
                              onClick={() => void handleConnectPlatform(p, 'api')}
                            >
                              {busy ? '연결 중…' : 'API로 연결'}
                            </button>
                            <button
                              type="button"
                              className="btn ghost sm"
                              disabled={busy}
                              onClick={() => void handleConnectPlatform(p, 'demo')}
                            >
                              데모 데이터로 연결
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div>
                          {p.connect.note && (
                            <div className="note" style={{ marginBottom: 12 }}>
                              {p.connect.note}
                            </div>
                          )}
                          {errMsg && (
                            <div className="note red" style={{ marginBottom: 12 }}>
                              {errMsg}
                            </div>
                          )}
                          <button
                            type="button"
                            className="btn ghost sm"
                            disabled={busy}
                            onClick={() => void handleConnectPlatform(p, 'demo')}
                          >
                            {busy ? '연결 중…' : '데모 데이터로 연결'}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="btn-row" style={{ justifyContent: 'space-between' }}>
              <button type="button" className="btn ghost" onClick={() => goToStep(0)}>
                ‹ 이전
              </button>
              <button type="button" className="btn" onClick={() => goToStep(2)}>
                다음 단계 ›
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <div className="field">
              <label className="label" htmlFor="onb-store-name">
                매장명
              </label>
              <input
                id="onb-store-name"
                type="text"
                className="input"
                placeholder="예: 야근금지스토어"
                value={storeName}
                onChange={(e) => setStoreName(e.target.value)}
              />
            </div>

            <div className="field">
              <span className="label">업종 선택</span>
              <div className="list">
                {CONFIG.bizTypes.map((b) => {
                  const isActive = bizType === b.id;
                  const isRec = recommendedBizType === b.id;
                  return (
                    <button
                      key={b.id}
                      type="button"
                      className="row"
                      style={{ width: '100%', textAlign: 'left' }}
                      onClick={() => {
                        setBizType(b.id);
                        setBizManuallyPicked(true);
                      }}
                    >
                      <div className="ico-box">{b.icon}</div>
                      <div className="row-body">
                        <div className="row-t1">
                          <span>{b.label}</span>
                          {isRec && <span className="chip blue">추천</span>}
                        </div>
                      </div>
                      <span className={`chip ${isActive ? 'solid' : 'gray'}`}>
                        {isActive ? '선택됨' : '선택'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="btn-row" style={{ justifyContent: 'space-between', marginTop: 18 }}>
              <button type="button" className="btn ghost" onClick={() => goToStep(1)}>
                ‹ 이전
              </button>
              <button type="button" className="btn" onClick={() => goToStep(3)}>
                다음 단계 ›
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <div className="note blue" style={{ marginBottom: 16 }}>
              채널톡 연동을 지금 입력하지 않아도 바로 시작할 수 있어요. 나중에 채널 설정에서 언제든 연결할 수 있습니다.
            </div>

            <div className="field">
              <label className="label" htmlFor="ct-key">
                채널톡 Access Key (선택)
              </label>
              <input
                id="ct-key"
                type="text"
                className="input"
                placeholder="x-access-key"
                value={ctKey}
                onChange={(e) => setCtKey(e.target.value)}
                disabled={submitting}
              />
            </div>

            <div className="field">
              <label className="label" htmlFor="ct-secret">
                채널톡 Access Secret (선택)
              </label>
              <input
                id="ct-secret"
                type="password"
                className="input"
                placeholder="x-access-secret"
                value={ctSecret}
                onChange={(e) => setCtSecret(e.target.value)}
                disabled={submitting}
              />
            </div>

            {submitError && (
              <div className="note red" role="alert" style={{ marginBottom: 14 }}>
                {submitError}
              </div>
            )}

            <div className="btn-row" style={{ justifyContent: 'space-between', marginTop: 18 }}>
              <button
                type="button"
                className="btn ghost"
                disabled={submitting}
                onClick={() => goToStep(2)}
              >
                ‹ 이전
              </button>
              <button
                type="button"
                className="btn"
                disabled={submitting}
                onClick={() => void handleFinish()}
              >
                {submitting ? '적용 중…' : '완료'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
