import { useQueryClient } from '@tanstack/react-query';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useMe } from './auth';
import { ErrorBox, Loading } from './components/ui';
import AdminLayout from './components/AdminLayout';
import Login, { ChangePassword } from './pages/Login';
import Platform from './pages/Platform';
import Pdv from './pages/Pdv';
import Dashboard from './pages/admin/Dashboard';
import Events from './pages/admin/Events';
import Products from './pages/admin/Products';
import Users from './pages/admin/Users';
import SalesAdmin from './pages/admin/Sales';
import Movements from './pages/admin/Movements';
import Settings from './pages/admin/Settings';

export default function App() {
  const me = useMe();
  const qc = useQueryClient();
  return (
    <Routes>
      <Route path="/plataforma" element={<Platform />} />
      <Route path="*" element={<CompanyApp />} />
    </Routes>
  );

  function CompanyApp() {
    if (me.isLoading) return <Loading />;
    if (me.isError) return <div className="p-6"><ErrorBox error={me.error} retry={() => me.refetch()} /></div>;
    const m = me.data;
    if (!m) return <Login onDone={() => qc.invalidateQueries({ queryKey: ['me'] })} />;
    if (m.mustChangePassword) return <ChangePassword onDone={() => qc.invalidateQueries({ queryKey: ['me'] })} />;
    const admin = m.user.role === 'COMPANY_ADMIN';
    return (
      <Routes>
        <Route path="/pdv" element={<Pdv me={m} />} />
        {admin && (
          <Route path="/admin" element={<AdminLayout me={m} />}>
            <Route index element={<Dashboard />} />
            <Route path="eventos" element={<Events />} />
            <Route path="produtos" element={<Products />} />
            <Route path="vendas" element={<SalesAdmin />} />
            <Route path="movimentacoes" element={<Movements />} />
            <Route path="usuarios" element={<Users me={m} />} />
            <Route path="configuracoes" element={<Settings />} />
          </Route>
        )}
        <Route path="*" element={<Navigate to={admin ? '/admin' : '/pdv'} replace />} />
      </Routes>
    );
  }
}
