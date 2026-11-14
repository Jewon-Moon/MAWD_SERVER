import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { Api } from '../lib/api';
import { CONFIG } from '../lib/config';

type AuthMode = 'login' | 'signup';

interface AuthResponse {
  token?: string;
  access_token?: string;
}

interface MeResponse {
  setup?: {
    done?: boolean;
    onboarded?: boolean;
  };
}

export const LoginPage: React.FC = () => {
  const { applyMe, pullServer, showToast } = useApp();
  const navigate = useNavigate();

  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleModeChange = (nextMode: AuthMode) => {
    setMode(nextMode);
    setError('');
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    const trimmedName = name.trim();

    if (!trimmedEmail || !password) {
      setError('이메일과 비밀번호를 입력해 주세요.');
      return;
    }
    if (mode === 'signup' && !trimmedName) {
      setError('사장님 성함 또는 매장명을 입력해 주세요.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const res: AuthResponse =
        mode === 'login'
          ? await Api.login(trimmedEmail, password)
          : await Api.signup(trimmedEmail, password, trimmedName);

      const token = res?.token || res?.access_token;
      if (!token) {
        throw new Error('인증 토큰을 받지 못했습니다. 다시 시도해 주세요.');
      }

      Api.setToken(token);
      const me = (await Api.me()) as MeResponse;
      applyMe(me);
      await pullServer().catch(() => {});

      showToast(mode === 'login' ? '로그인되었습니다' : '회원가입이 완료되었습니다');
      const isDone = Boolean(me?.setup?.done ?? me?.setup?.onboarded);
      navigate(isDone ? '/' : '/onboarding', { replace: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '로그인에 실패했습니다.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 22 }}>
          <div className="brand-mark">{CONFIG.brand.mark}</div>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.4px', lineHeight: 1.25 }}>
              {CONFIG.brand.name}
            </h1>
            <p style={{ fontSize: 13, color: 'var(--mute)', marginTop: 2 }}>
              악성·반복 문의를 걸러주는 AI 응대 비서
            </p>
          </div>
        </div>

        <div className="seg" role="tablist" aria-label="인증 방식" style={{ width: '100%', marginBottom: 20 }}>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'login'}
            className={`seg-btn ${mode === 'login' ? 'is-active' : ''}`}
            style={{ flex: 1 }}
            onClick={() => handleModeChange('login')}
          >
            로그인
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'signup'}
            className={`seg-btn ${mode === 'signup' ? 'is-active' : ''}`}
            style={{ flex: 1 }}
            onClick={() => handleModeChange('signup')}
          >
            회원가입
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          {mode === 'signup' && (
            <div className="field">
              <label className="label" htmlFor="auth-name">
                사장님 성함 / 매장명
              </label>
              <input
                id="auth-name"
                type="text"
                className="input"
                placeholder="예: 홍길동 / 야근금지스토어"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                disabled={loading}
              />
            </div>
          )}

          <div className="field">
            <label className="label" htmlFor="auth-email">
              이메일
            </label>
            <input
              id="auth-email"
              type="email"
              className="input"
              placeholder="owner@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              disabled={loading}
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="auth-password">
              비밀번호
            </label>
            <input
              id="auth-password"
              type="password"
              className="input"
              placeholder="비밀번호 입력"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              disabled={loading}
            />
          </div>

          {error && (
            <div className="note red" role="alert" style={{ marginBottom: 14 }}>
              {error}
            </div>
          )}

          <button type="submit" className="btn block" disabled={loading}>
            {loading ? '처리 중…' : mode === 'login' ? '로그인' : '회원가입'}
          </button>
        </form>
      </div>
    </div>
  );
};
