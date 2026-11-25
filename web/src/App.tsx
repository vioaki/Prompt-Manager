import { Navigate, Route, Routes } from 'react-router-dom';
import { AboutPage } from './pages/AboutPage';
import { AuthCallbackPage } from './pages/AuthCallbackPage';
import { GalleryPage } from './pages/GalleryPage';
import { ReviewPage } from './pages/ReviewPage';
import { UploadPage } from './pages/UploadPage';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<GalleryPage />}>
        <Route path="item/:id" element={null} />
      </Route>
      <Route path="/templates" element={<GalleryPage categoryFilter="template" />}>
        <Route path="item/:id" element={null} />
      </Route>
      <Route path="/upload" element={<UploadPage />} />
      <Route path="/review" element={<ReviewPage />} />
      <Route path="/about" element={<AboutPage />} />
      <Route path="/auth/callback" element={<AuthCallbackPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
