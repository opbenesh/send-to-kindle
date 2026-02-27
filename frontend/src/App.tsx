import React, { useState, useEffect } from 'react';
import './App.css';
import { Send, Settings, BookOpen, LogIn, LogOut, CheckCircle } from 'lucide-react';
import { useGoogleLogin, GoogleOAuthProvider } from '@react-oauth/google';

// IMPORTANT: Replace with your actual Client ID in .env
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;

function MainApp() {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [kindleEmail, setKindleEmail] = useState(() => localStorage.getItem('kindleEmail') || '');
  const [authType, setAuthType] = useState<'smtp' | 'google'>('google');
  const [user, setUser] = useState<{ email: string, access_token: string } | null>(null);

  useEffect(() => {
    // Check if we are being shared a URL from Android
    const params = new URLSearchParams(window.location.search);
    const sharedUrl = params.get('url') || params.get('text') || params.get('title');
    
    if (sharedUrl) {
      // Find a URL in the string (sometimes text is shared as 'Title: http://link')
      const urlRegex = /(https?:\/\/[^\s]+)/g;
      const match = sharedUrl.match(urlRegex);
      if (match) {
        setUrl(match[0]);
        fetchMetadata(match[0]);
      } else if (sharedUrl.startsWith('http')) {
        setUrl(sharedUrl);
        fetchMetadata(sharedUrl);
      }
    }
  }, []);

  const fetchMetadata = async (targetUrl: string) => {
    if (!targetUrl) return;
    setStatus({ type: 'loading', message: 'Fetching metadata...' });
    try {
      const res = await fetch(`/api/extract?url=${encodeURIComponent(targetUrl)}`);
      if (res.ok) {
        const data = await res.json();
        setTitle(data.title || '');
        setAuthor(data.author || data.siteName || '');
        setStatus({ type: null, message: '' });
      } else {
        setStatus({ type: 'error', message: 'Could not fetch metadata automatically.' });
      }
    } catch (err) {
      setStatus({ type: 'error', message: 'Failed to connect to backend.' });
    }
  };

  useEffect(() => {
    localStorage.setItem('kindleEmail', kindleEmail);
  }, [kindleEmail]);
  
  const [smtpSettings, setSmtpSettings] = useState({
    host: '',
    port: '587',
    user: '',
    pass: '',
    from: '',
  });
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error' | 'loading' | null, message: string }>({
    type: null,
    message: '',
  });

  const login = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      try {
        const userInfo = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
        }).then(res => res.json());
        
        setUser({
          email: userInfo.email,
          access_token: tokenResponse.access_token
        });
        setStatus({ type: 'success', message: `Signed in as ${userInfo.email}` });
      } catch (err) {
        setStatus({ type: 'error', message: 'Failed to get user info from Google' });
      }
    },
    scope: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email',
  });

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (authType === 'google' && !user) {
      setStatus({ type: 'error', message: 'Please sign in with Google first.' });
      return;
    }

    setLoading(true);
    setStatus({ type: 'loading', message: 'Extracting article and generating EPUB...' });

    try {
      const response = await fetch('/api/send-to-kindle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          title,
          author,
          kindleEmail,
          authType,
          accessToken: user?.access_token,
          userEmail: user?.email,
          smtpSettings: authType === 'smtp' ? {
            ...smtpSettings,
            port: parseInt(smtpSettings.port),
          } : undefined,
        }),
      });

      const data = await response.json();

      if (response.ok) {
        setStatus({ type: 'success', message: 'Article sent to Kindle successfully!' });
        setUrl('');
        setTitle('');
        setAuthor('');
      } else {
        setStatus({ type: 'error', message: data.error || 'Failed to send article.' });
      }
    } catch (error) {
      setStatus({ type: 'error', message: 'An error occurred. Make sure the backend is running.' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container">
      <h1><BookOpen size={32} style={{ verticalAlign: 'middle', marginRight: '10px' }} /> Opbenesh's Send to Kindle</h1>
      
      <div className="tabs" style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
        <button 
          className={authType === 'google' ? 'active' : ''} 
          onClick={() => setAuthType('google')}
          style={{ background: authType === 'google' ? '#3498db' : '#eee', color: authType === 'google' ? 'white' : '#333', fontSize: '14px', padding: '10px' }}
        >
          Google Login
        </button>
        <button 
          className={authType === 'smtp' ? 'active' : ''} 
          onClick={() => setAuthType('smtp')}
          style={{ background: authType === 'smtp' ? '#3498db' : '#eee', color: authType === 'smtp' ? 'white' : '#333', fontSize: '14px', padding: '10px' }}
        >
          Manual SMTP
        </button>
      </div>

      <form onSubmit={handleSend}>
        <div className="form-group">
          <label htmlFor="url">Article URL</label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              id="url"
              type="text"
              placeholder="https://example.com/article"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
            <button 
              type="button" 
              onClick={() => fetchMetadata(url)}
              style={{ width: 'auto', margin: 0, padding: '0 15px', fontSize: '14px' }}
              disabled={!url || loading}
            >
              Fetch
            </button>
          </div>
        </div>

        {(title || author) && (
          <div className="cover-preview" style={{ 
            background: '#fff', 
            border: '2px solid #333', 
            padding: '20px', 
            marginBottom: '20px', 
            borderRadius: '4px',
            textAlign: 'center',
            boxShadow: '5px 5px 0px rgba(0,0,0,0.1)'
          }}>
            <span style={{ fontSize: '10px', textTransform: 'uppercase', color: '#888', letterSpacing: '2px' }}>Ebook Cover Preview</span>
            <div className="form-group" style={{ marginTop: '15px' }}>
              <input
                style={{ textAlign: 'center', fontSize: '1.2em', fontWeight: 'bold', border: 'none', borderBottom: '1px solid #eee' }}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Article Title"
              />
            </div>
            <div className="form-group">
              <input
                style={{ textAlign: 'center', fontSize: '0.9em', color: '#666', border: 'none' }}
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder="Author"
              />
            </div>
          </div>
        )}

        <div className="form-group">
          <label htmlFor="kindleEmail">Kindle Email Address</label>
          <input
            id="kindleEmail"
            type="email"
            placeholder="yourname@kindle.com"
            value={kindleEmail}
            onChange={(e) => setKindleEmail(e.target.value)}
            required
          />
        </div>

        {authType === 'google' ? (
          <div className="smtp-config">
            <h3>Google Authentication</h3>
            {!user ? (
              <button type="button" onClick={() => login()} style={{ background: '#4285F4' }}>
                <LogIn size={18} style={{ verticalAlign: 'middle', marginRight: '8px' }} />
                Sign in with Google
              </button>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#d4edda', padding: '10px', borderRadius: '4px' }}>
                <span><CheckCircle size={16} color="green" /> {user.email}</span>
                <button type="button" onClick={() => setUser(null)} style={{ width: 'auto', padding: '5px 10px', margin: 0, fontSize: '12px', background: '#e74c3c' }}>
                  <LogOut size={14} />
                </button>
              </div>
            )}
            <p style={{ fontSize: '12px', color: '#666', marginTop: '10px' }}>
              Note: This email must be in your Amazon "Approved E-mail List".
            </p>
          </div>
        ) : (
          <div className="smtp-config">
            <h3><Settings size={18} style={{ verticalAlign: 'middle', marginRight: '8px' }} /> SMTP Settings</h3>
            <div className="form-group">
              <label htmlFor="smtpFrom">Sender Email (Authorized in Amazon)</label>
              <input
                id="smtpFrom"
                type="email"
                placeholder="you@gmail.com"
                value={smtpSettings.from}
                onChange={(e) => setSmtpSettings({ ...smtpSettings, from: e.target.value })}
                required
              />
            </div>
            <div className="smtp-grid">
              <div className="form-group">
                <label htmlFor="smtpHost">SMTP Host</label>
                <input
                  id="smtpHost"
                  type="text"
                  placeholder="smtp.gmail.com"
                  value={smtpSettings.host}
                  onChange={(e) => setSmtpSettings({ ...smtpSettings, host: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="smtpPort">Port</label>
                <input
                  id="smtpPort"
                  type="text"
                  placeholder="587"
                  value={smtpSettings.port}
                  onChange={(e) => setSmtpSettings({ ...smtpSettings, port: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="smtpUser">Username</label>
                <input
                  id="smtpUser"
                  type="text"
                  placeholder="you@gmail.com"
                  value={smtpSettings.user}
                  onChange={(e) => setSmtpSettings({ ...smtpSettings, user: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="smtpPass">Password / App Password</label>
                <input
                  id="smtpPass"
                  type="password"
                  placeholder="••••••••"
                  value={smtpSettings.pass}
                  onChange={(e) => setSmtpSettings({ ...smtpSettings, pass: e.target.value })}
                  required
                />
              </div>
            </div>
          </div>
        )}

        <button type="submit" disabled={loading}>
          {loading ? 'Processing...' : (
            <>
              <Send size={18} style={{ verticalAlign: 'middle', marginRight: '8px' }} /> 
              Send to Kindle
            </>
          )}
        </button>
      </form>

      {status.type && (
        <div className={`status ${status.type}`}>
          {status.message}
        </div>
      )}
    </div>
  );
}

function App() {
  return (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <MainApp />
    </GoogleOAuthProvider>
  );
}

export default App;
