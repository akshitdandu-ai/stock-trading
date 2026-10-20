import { NextResponse, type NextRequest } from 'next/server';

// Optional HTTP Basic auth for the whole app (everything except static assets and /api/health).
// This dashboard shows your (paper) trading book and can place paper orders: set DASHBOARD_PASSWORD
// on any public deployment. The username can be anything.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function proxy(req: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return NextResponse.next();
  const header = req.headers.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    try {
      const decoded = atob(header.slice(6));
      if (safeEqual(decoded.slice(decoded.indexOf(':') + 1), password)) return NextResponse.next();
    } catch {
      // fall through to 401
    }
  }
  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Swing Paper Trader"' },
  });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/health).*)'],
};
