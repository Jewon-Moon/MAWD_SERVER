import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { CONFIG, bizTypeOf } from '../lib/config';

const NAV_ITEMS = [
  { id: 'home', icon: '🏠', label: '홈', to: '/' },
  { id: 'inquiries', icon: '📋', label: '문의', to: '/inquiries' },
  { id: 'sns', icon: '📷', label: 'SNS', to: '/sns' },
  { id: 'channels', icon: '💬', label: '채널', to: '/channels' },
  { id: 'customers', icon: '👤', label: '고객', to: '/customers' },
  { id: 'knowledge', icon: '📚', label: '매장 지식', to: '/knowledge' },
  { id: 'settings', icon: '⚙️', label: '설정', to: '/settings' },
  { id: 'demo', icon: '📞', label: '통화 기록', to: '/demo' },
] as const;

const MOBILE_TABS = NAV_ITEMS.slice(0, 5);

interface LayoutProps {
  title: string;
  subtitle?: string;
  backTo?: string;
  children: React.ReactNode;
}

export const Layout: React.FC<LayoutProps> = ({ title, subtitle, backTo, children }) => {
  const { data, toastMsg } = useApp();
  const location = useLocation();
  const navigate = useNavigate();

  const pendingCount = data.items.filter((it) => !it.handled).length;
  const storeName = data.settings.storeName || CONFIG.brand.owner;
  const biz = bizTypeOf(data.settings.bizType);

  const isActive = (to: string) => {
    if (to === '/') return location.pathname === '/';
    return location.pathname === to || location.pathname.startsWith(to + '/');
  };

  return (
    <div className="app">
      <aside className="sidebar" aria-label="주 메뉴">
        <Link className="brand" to="/">
          <div className="brand-mark">{CONFIG.brand.mark}</div>
          <div className="brand-text">
            <div className="bt1">{CONFIG.brand.name}</div>
            <div className="bt2">{storeName}</div>
          </div>
        </Link>

        <nav className="nav">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.id}
              to={item.to}
              className={`nav-item ${isActive(item.to) ? 'is-active' : ''}`}
            >
              <span className="nav-ico">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
              {item.id === 'inquiries' && pendingCount > 0 && (
                <span className="nav-count">{pendingCount}</span>
              )}
            </Link>
          ))}
        </nav>

        <div className="side-foot">
          <div className="side-card">
            <div className="sc1">
              {biz.icon} {storeName}
            </div>
            <div className="sc2">
              {biz.label} · {CONFIG.brand.plan}
            </div>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          {backTo && (
            <button
              type="button"
              className="back"
              onClick={() => navigate(backTo)}
              aria-label="뒤로 가기"
            >
              ‹
            </button>
          )}
          <div className="topbar-t">
            <h1>{title}</h1>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <Link className="icon-btn" to="/inquiries" aria-label="답변할 문의">
            🔔
            {pendingCount > 0 && <span className="pip" />}
          </Link>
        </header>

        <main className="view">{children}</main>
      </div>

      <nav className="tabbar" aria-label="모바일 탭">
        {MOBILE_TABS.map((item) => (
          <Link
            key={item.id}
            to={item.to}
            className={`tab ${isActive(item.to) ? 'is-active' : ''}`}
          >
            <span className="tab-ico">{item.icon}</span>
            <span>{item.label}</span>
            {item.id === 'inquiries' && pendingCount > 0 && <span className="pip" />}
          </Link>
        ))}
      </nav>

      {toastMsg && (
        <div className="toast" role="status" aria-live="polite">
          {toastMsg}
        </div>
      )}
    </div>
  );
};
