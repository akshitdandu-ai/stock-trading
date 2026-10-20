'use client';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="banner bad big" role="alert">
      <strong>Something went wrong loading this page</strong>
      <p>
        Most often this is the database connection: check <code>DATABASE_URL</code> (Supabase transaction pooler) and that
        the migration has been applied.
      </p>
      <p className="small">{error.message.replace(/postgres(ql)?:\/\/\S+/gi, '[hidden]')}</p>
      <button type="button" onClick={() => reset()}>Try again</button>
    </div>
  );
}
