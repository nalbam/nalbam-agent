export default function Loading() {
  return (
    <div
      className="flex min-h-screen items-center justify-center"
      role="status"
      aria-label="Loading"
    >
      <div className="border-muted border-t-primary h-8 w-8 animate-spin rounded-full border-2" />
    </div>
  );
}
