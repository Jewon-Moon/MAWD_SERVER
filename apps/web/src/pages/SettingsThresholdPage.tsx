import React from 'react';
import { Layout } from '../components/Layout';
import { useApp } from '../context/AppContext';
import { CONFIG } from '../lib/config';

export const SettingsThresholdPage: React.FC = () => {
  const { data, setLocalSettings } = useApp();

  return (
    <Layout title="판정 기준" subtitle="데모 채점 및 규칙 확인" backTo="/settings">
      <section className="sec">
        <div className="sec-head">
          <h2>임계값 설정</h2>
        </div>

        <div className="card">
          <div className="field">
            <div className="th-row">
              <label className="th-label" htmlFor="th-hold-range">
                격앙 보류 기준
              </label>
              <span className="chip solid">{data.settings.thHold}점</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="hint" style={{ marginTop: 0 }}>0</span>
              <input
                id="th-hold-range"
                type="range"
                className="range"
                min={0}
                max={100}
                value={data.settings.thHold}
                onChange={(e) => setLocalSettings({ thHold: Number(e.target.value) })}
              />
              <span className="hint" style={{ marginTop: 0 }}>100</span>
            </div>
            <div className="hint">
              감정·위협 점수가 이 기준 이상이면 자동 응대를 멈추고 사장님 확인 카드로 보류합니다.
            </div>
          </div>

          <div className="field" style={{ marginBottom: 0 }}>
            <div className="th-row">
              <label className="th-label" htmlFor="th-repeat-range">
                반복 이슈 감지 기준
              </label>
              <span className="chip solid">{data.settings.thRepeat}건</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="hint" style={{ marginTop: 0 }}>2</span>
              <input
                id="th-repeat-range"
                type="range"
                className="range"
                min={2}
                max={20}
                value={data.settings.thRepeat}
                onChange={(e) => setLocalSettings({ thRepeat: Number(e.target.value) })}
              />
              <span className="hint" style={{ marginTop: 0 }}>20</span>
            </div>
            <div className="hint">
              동일 주제의 문의가 이 건수 이상 모이면 공지 발송을 제안합니다.
            </div>
          </div>
        </div>
      </section>

      <section className="sec">
        <div className="sec-head">
          <h2>채점 규칙 ({CONFIG.rules.length}개)</h2>
        </div>

        <div className="list">
          {CONFIG.rules.map((r) => {
            const ptsText = r.pts > 0 ? `+${r.pts}점` : `${r.pts}점`;
            return (
              <div key={r.label} className="row">
                <div className="row-body">
                  <div className="row-t1">{r.label}</div>
                  <div className="row-t2">
                    <code>{r.re}</code>
                  </div>
                </div>
                <span className={`chip ${r.tone}`}>{ptsText}</span>
              </div>
            );
          })}
        </div>
      </section>
    </Layout>
  );
};
