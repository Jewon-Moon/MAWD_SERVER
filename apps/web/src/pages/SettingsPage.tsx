import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { useApp } from '../context/AppContext';
import { CONFIG, bizTypeOf } from '../lib/config';
import type { BizTypeId } from '../lib/types';

const FORMALITY_LABELS: Record<string, string> = {
  polite: '해요체',
  formal: '하십시오체',
  casual: '반말',
};

function formatSla(minutes: number): string {
  if (minutes >= 1440) {
    const days = Math.round(minutes / 1440);
    return `${days}일 이내`;
  }
  if (minutes >= 60) {
    const hours = Math.round(minutes / 60);
    return `${hours}시간 이내`;
  }
  return `${minutes}분 이내`;
}

export const SettingsPage: React.FC = () => {
  const {
    data,
    setLocalSettings,
    setNotice,
    reseed,
    clearAll,
    logout,
  } = useApp();
  const navigate = useNavigate();

  const storeName = data.settings.storeName || CONFIG.brand.owner;
  const biz = bizTypeOf(data.settings.bizType);
  const email = data.settings.email || CONFIG.brand.email;
  const plan = CONFIG.brand.plan;

  const aiName = data.store.persona?.assistant_name || CONFIG.storeSettings.defaults.persona.assistant_name;
  const heatThreshold = data.store.response?.heat_threshold ?? CONFIG.storeSettings.defaults.response.heat_threshold;
  const slaMinutes = data.store.response?.owner_reply_sla_minutes ?? CONFIG.storeSettings.defaults.response.owner_reply_sla_minutes;
  const formality = data.store.persona?.formality || CONFIG.storeSettings.defaults.persona.formality;

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <Layout title="설정" subtitle="매장 정보 및 AI 응대 설정">
      <section className="sec">
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div className="avatar" aria-hidden="true">
            {biz.icon}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 17 }}>{storeName}</strong>
              <span className="chip blue">{biz.label}</span>
              <span className="chip gray">{plan}</span>
            </div>
            <div className="row-t2" style={{ marginTop: 4 }}>
              {email}
            </div>
          </div>
        </div>
      </section>

      <section className="sec">
        <div className="sec-head">
          <h2>매장 정보</h2>
        </div>
        <div className="card">
          <div className="set-row">
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label" htmlFor="settings-store-name">
                매장명
              </label>
              <input
                id="settings-store-name"
                type="text"
                className="input"
                placeholder={CONFIG.brand.owner}
                value={data.settings.storeName}
                onChange={(e) => setLocalSettings({ storeName: e.target.value })}
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label" htmlFor="settings-biz-type">
                업종
              </label>
              <select
                id="settings-biz-type"
                className="select"
                value={data.settings.bizType}
                onChange={(e) => setLocalSettings({ bizType: e.target.value as BizTypeId })}
              >
                {CONFIG.bizTypes.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.icon} {b.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </section>

      <section className="sec">
        <div className="sec-head">
          <h2>매장 설정 (서버 연동)</h2>
        </div>
        <div className="list">
          <Link to="/settings/store" className="row">
            <div className="ico-box" aria-hidden="true">
              🤖
            </div>
            <div className="row-body">
              <div className="row-t1">AI · 영업시간 · 매장 지식 설정</div>
              <div className="row-t2">
                AI 이름: {aiName} · 격앙 기준: {heatThreshold}점
              </div>
            </div>
            <div className="row-val">서버 동기화</div>
            <span className="chev" aria-hidden="true">
              ›
            </span>
          </Link>
        </div>
      </section>

      <section className="sec">
        <div className="sec-head">
          <h2>방패 설정 (데모 채점)</h2>
        </div>
        <div className="list">
          <Link to="/settings/channels" className="row">
            <div className="ico-box" aria-hidden="true">
              🔗
            </div>
            <div className="row-body">
              <div className="row-t1">채널 연결</div>
              <div className="row-t2">채널톡 · 인스타그램 · 커머스 · 주문 CSV</div>
            </div>
            <span className="chev" aria-hidden="true">
              ›
            </span>
          </Link>

          <Link to="/settings/threshold" className="row">
            <div className="ico-box" aria-hidden="true">
              🛡
            </div>
            <div className="row-body">
              <div className="row-t1">판정 기준</div>
              <div className="row-t2">격앙 보류 점수 및 반복 이슈 기준</div>
            </div>
            <div className="row-val">
              {data.settings.thHold}점 / {data.settings.thRepeat}건
            </div>
            <span className="chev" aria-hidden="true">
              ›
            </span>
          </Link>

          <Link to="/settings/tone" className="row">
            <div className="ico-box" aria-hidden="true">
              🗣
            </div>
            <div className="row-body">
              <div className="row-t1">접수 확인 · 말투</div>
              <div className="row-t2">응답 약속 시간 및 AI 존댓말 수준</div>
            </div>
            <div className="row-val">
              {formatSla(slaMinutes)} · {FORMALITY_LABELS[formality] || formality}
            </div>
            <span className="chev" aria-hidden="true">
              ›
            </span>
          </Link>
        </div>
      </section>

      <section className="sec">
        <div className="sec-head">
          <h2>알림</h2>
        </div>
        <div className="list">
          {CONFIG.notices.map((n) => {
            const checked = Boolean(data.settings.notices[n.id]);
            return (
              <label key={n.id} className="row" style={{ cursor: 'pointer' }}>
                <div className="ico-box" aria-hidden="true">
                  {n.icon}
                </div>
                <div className="row-body">
                  <div className="row-t1">{n.name}</div>
                  <div className="row-t2">{n.desc}</div>
                </div>
                <span className="sw-wrap">
                  <input
                    type="checkbox"
                    className="sw-input"
                    checked={checked}
                    onChange={(e) => setNotice(n.id, e.target.checked)}
                  />
                  <span className="sw-track" />
                </span>
              </label>
            );
          })}
        </div>
      </section>

      <section className="sec">
        <div className="sec-head">
          <h2>AI 전화 데모 연동</h2>
        </div>
        <div className="card">
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="label" htmlFor="settings-api-url">
              API 서버 주소
            </label>
            <input
              id="settings-api-url"
              type="url"
              className="input"
              placeholder={CONFIG.api.base}
              value={data.settings.apiUrl}
              onChange={(e) => setLocalSettings({ apiUrl: e.target.value })}
            />
            <div className="hint">
              비워두면 기본 서버({CONFIG.api.base})를 사용합니다.
            </div>
          </div>
        </div>
      </section>

      <section className="sec">
        <div className="sec-head">
          <h2>데이터</h2>
        </div>
        <div className="card">
          <div className="btn-row">
            <button type="button" className="btn ghost" onClick={reseed}>
              더미 데이터 다시 채우기
            </button>
            <button type="button" className="btn ghost" onClick={clearAll}>
              전체 비우기
            </button>
            <button
              type="button"
              className="btn danger"
              style={{ marginLeft: 'auto' }}
              onClick={handleLogout}
            >
              로그아웃
            </button>
          </div>
        </div>
      </section>
    </Layout>
  );
};
