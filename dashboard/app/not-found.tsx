import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="empty">
      <strong>Page not found</strong>
      <Link href="/">Back to Today</Link>
    </div>
  );
}
