import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppProvider, useApp } from './context/AppContext';
import { DashboardPage } from './pages/DashboardPage';
import { InquiriesPage } from './pages/InquiriesPage';
import { InquiryDetailPage } from './pages/InquiryDetailPage';
import { SnsPage } from './pages/SnsPage';
import { ChannelsPage } from './pages/ChannelsPage';
import { CustomersPage } from './pages/CustomersPage';
import { DemoPage } from './pages/DemoPage';
import { TestPage } from './pages/TestPage';
import { SettingsPage } from './pages/SettingsPage';
import { SettingsChannelsPage } from './pages/SettingsChannelsPage';
import { SettingsThresholdPage } from './pages/SettingsThresholdPage';
import { SettingsTonePage } from './pages/SettingsTonePage';
import { SettingsStorePage } from './pages/SettingsStorePage';
import { LoginPage } from './pages/LoginPage';
import { OnboardingPage } from './pages/OnboardingPage';

const RequireAuth: React.FC<{ children: React.ReactElement }> = ({ children }) => {
  const { isAuthed, data } = useApp();
  if (!isAuthed) return <Navigate to="/login" replace />;
  if (!data.settings.onboarded) return <Navigate to="/onboarding" replace />;
  return children;
};

const RequireAuthOnly: React.FC<{ children: React.ReactElement }> = ({ children }) => {
  const { isAuthed } = useApp();
  if (!isAuthed) return <Navigate to="/login" replace />;
  return children;
};

const AppRoutes: React.FC = () => {
  const { authChecked, isAuthed, data } = useApp();

  if (!authChecked) {
    return (
      <div className="auth-shell">
        <div className="auth-card" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>🛡</div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>사장님 마음지키미</div>
          <div className="row-t2" style={{ marginTop: 6 }}>계정 상태를 확인하고 있습니다...</div>
        </div>
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={isAuthed ? <Navigate to={data.settings.onboarded ? '/' : '/onboarding'} replace /> : <LoginPage />}
      />
      <Route path="/onboarding" element={<RequireAuthOnly><OnboardingPage /></RequireAuthOnly>} />

      <Route path="/" element={<RequireAuth><DashboardPage /></RequireAuth>} />
      <Route path="/inquiries" element={<RequireAuth><InquiriesPage /></RequireAuth>} />
      <Route path="/inquiries/:id" element={<RequireAuth><InquiryDetailPage /></RequireAuth>} />
      <Route path="/sns" element={<RequireAuth><SnsPage /></RequireAuth>} />
      <Route path="/channels" element={<RequireAuth><ChannelsPage /></RequireAuth>} />
      <Route path="/customers" element={<RequireAuth><CustomersPage /></RequireAuth>} />
      <Route path="/customers/:id" element={<RequireAuth><CustomersPage /></RequireAuth>} />
      <Route path="/demo" element={<RequireAuth><DemoPage /></RequireAuth>} />
      <Route path="/test" element={<RequireAuth><TestPage /></RequireAuth>} />

      <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
      <Route path="/settings/channels" element={<RequireAuth><SettingsChannelsPage /></RequireAuth>} />
      <Route path="/settings/threshold" element={<RequireAuth><SettingsThresholdPage /></RequireAuth>} />
      <Route path="/settings/tone" element={<RequireAuth><SettingsTonePage /></RequireAuth>} />
      <Route path="/settings/store" element={<RequireAuth><SettingsStorePage /></RequireAuth>} />

      {/* Legacy .html path redirects */}
      <Route path="/index.html" element={<Navigate to="/" replace />} />
      <Route path="/inquiries.html" element={<Navigate to="/inquiries" replace />} />
      <Route path="/sns.html" element={<Navigate to="/sns" replace />} />
      <Route path="/channels.html" element={<Navigate to="/channels" replace />} />
      <Route path="/demo.html" element={<Navigate to="/demo" replace />} />
      <Route path="/customer/list.html" element={<Navigate to="/customers" replace />} />
      <Route path="/customer/detail.html" element={<Navigate to="/customers" replace />} />
      <Route path="/settings/main.html" element={<Navigate to="/settings" replace />} />
      <Route path="/settings/channels.html" element={<Navigate to="/settings/channels" replace />} />
      <Route path="/settings/threshold.html" element={<Navigate to="/settings/threshold" replace />} />
      <Route path="/settings/tone.html" element={<Navigate to="/settings/tone" replace />} />
      <Route path="/settings/store.html" element={<Navigate to="/settings/store" replace />} />
      <Route path="/auth/login.html" element={<Navigate to="/login" replace />} />
      <Route path="/onboarding/onboarding.html" element={<Navigate to="/onboarding" replace />} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
};

export const App: React.FC = () => (
  <BrowserRouter>
    <AppProvider>
      <AppRoutes />
    </AppProvider>
  </BrowserRouter>
);

export default App;
