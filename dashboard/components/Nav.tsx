'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS = [
  { href: '/', full: 'Today', short: 'Today' },
  { href: '/suggestions', full: 'Suggestions', short: 'Ideas' },
  { href: '/positions', full: 'Positions', short: 'Open' },
  { href: '/performance', full: 'Performance', short: 'Perf' },
  { href: '/journal', full: 'Journal', short: 'Journal' },
  { href: '/backtest', full: 'Backtest', short: 'Test' },
  { href: '/settings', full: 'Settings', short: 'Settings' },
];

export default function Nav() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {ITEMS.map((i) => {
        const active = i.href === '/' ? path === '/' : path.startsWith(i.href);
        return (
          <Link key={i.href} href={i.href} aria-current={active ? 'page' : undefined}>
            <span className="full">{i.full}</span>
            <span className="short">{i.short}</span>
          </Link>
        );
      })}
    </nav>
  );
}
