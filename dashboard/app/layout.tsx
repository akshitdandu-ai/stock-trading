import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import Nav from '@/components/Nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Swing Paper Trader',
  description: 'NSE swing-trading research and paper-trading dashboard',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#1a1a1d' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN">
      <body>
        <header className="topbar">
          <div className="topbar-inner">
            <Link href="/" className="brand">Swing Paper Trader<small>NSE · paper only</small></Link>
            <Nav />
          </div>
        </header>
        <main className="wrap">{children}</main>
        <footer className="footer">
          Paper trading only: no broker integration, no real orders, no real money. Research tool, not investment advice.
          Prices are NSE end-of-day data; fills assume the next session's open.
        </footer>
      </body>
    </html>
  );
}
