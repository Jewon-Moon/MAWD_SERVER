import React from 'react';
import { Layout } from '../components/Layout';
import { useApp } from '../context/AppContext';
import { CONFIG } from '../lib/config';

const SLA_OPTIONS: Array<{ minutes: number; label: string; desc: string }> = [
  { minutes: 120, label: '2시간 이내', desc: '120분 · 빠른 응대가 필요한 매장' },
  { minutes: 1440, label: '1일 이내', desc: '1440분 · 일반 영업일 기준' },
  { minutes: 4320, label: '3일 이내', desc: '4320분 · 여유 있는 안내' },
];

const FORMALITY_OPTIONS: Array<{ value: 'polite' | 'formal' | 'casual'; label: string; desc: string }> = [
  { value: 'polite', label: '해요체', desc: '친절하고 부드러운 기본 응대 (~해요)' },
  { value: 'formal', label: '하십시오체', desc: '격식 있고 정중한 응대 (~습니다)' },
  { value: 'casual', label: '반말', desc: '친근한 반말 응대 (~해)' },
];

export const SettingsTonePage: React.FC = () => {
  const { data, setStoreField } = useApp();

  const currentSla =
    data.store.response?.owner_reply_sla_minutes ??
    CONFIG.storeSettings.defaults.response.owner_reply_sla_minutes;
  const currentFormality =
    data.store.persona?.formality || CONFIG.storeSettings.defaults.persona.formality;

  return (
    <Layout title="접수 확인 · 말투" subtitle="응답 약속 시간 및 AI 말투" backTo="/settings">
      <section className="sec">
        <div className="sec-head">
          <h2>접수 확인 안내 미리보기</h2>
        </div>

        <div className="card">
          <div className="tape" style={{ maxHeight: 'none', marginBottom: 12 }}>
            <div className="msg">
              <div className="msg-av" aria-hidden="true">
                🛡
              </div>
              <div className="bubble">{CONFIG.receipt.message}</div>
            </div>
          </div>
          <div className="note">{CONFIG.receipt.note}</div>
        </div>
      </section>

      <section className="sec">
        <div className="sec-head">
          <h2>응답 약속 시간</h2>
        </div>

        <div className="list">
          {SLA_OPTIONS.map((opt) => {
            const active = currentSla === opt.minutes;
            return (
              <button
                key={opt.minutes}
                type="button"
                className="row"
                style={{ width: '100%', textAlign: 'left' }}
                onClick={() => setStoreField('response', 'owner_reply_sla_minutes', opt.minutes)}
              >
                <div className="row-body">
                  <div className="row-t1">{opt.label}</div>
                  <div className="row-t2">{opt.desc}</div>
                </div>
                <span className={`chip ${active ? 'solid' : 'gray'}`}>
                  {active ? '선택됨' : '선택'}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="sec">
        <div className="sec-head">
          <h2>말투</h2>
        </div>

        <div className="list">
          {FORMALITY_OPTIONS.map((opt) => {
            const active = currentFormality === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                className="row"
                style={{ width: '100%', textAlign: 'left' }}
                onClick={() => setStoreField('persona', 'formality', opt.value)}
              >
                <div className="row-body">
                  <div className="row-t1">{opt.label}</div>
                  <div className="row-t2">{opt.desc}</div>
                </div>
                <span className={`chip ${active ? 'solid' : 'gray'}`}>
                  {active ? '선택됨' : '선택'}
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </Layout>
  );
};
