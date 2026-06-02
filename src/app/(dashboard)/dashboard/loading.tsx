export default function Loading() {
  return (
    <div className="space-y-8 pb-8 animate-pulse">
      {/* Header skeleton */}
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <div className="h-3 w-32 rounded-full" style={{ background: "rgba(255,255,255,0.06)" }} />
          <div className="h-8 w-52 rounded-xl" style={{ background: "rgba(255,255,255,0.06)" }} />
          <div className="h-3 w-48 rounded-full" style={{ background: "rgba(255,255,255,0.04)" }} />
        </div>
        <div className="h-10 w-28 rounded-xl" style={{ background: "rgba(255,255,255,0.06)" }} />
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="rounded-2xl p-5 h-28" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }} />
        ))}
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {[...Array(2)].map((_, i) => (
          <div key={i} className="rounded-2xl h-20" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }} />
        ))}
      </div>

      {/* Recent scans */}
      <div className="rounded-2xl overflow-hidden" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)" }}>
        <div className="px-6 py-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <div className="h-4 w-28 rounded-full" style={{ background: "rgba(255,255,255,0.06)" }} />
        </div>
        {[...Array(4)].map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-6 py-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
            <div className="w-10 h-10 rounded-xl flex-shrink-0" style={{ background: "rgba(255,255,255,0.05)" }} />
            <div className="flex-1 space-y-2">
              <div className="h-3.5 w-40 rounded-full" style={{ background: "rgba(255,255,255,0.06)" }} />
              <div className="h-3 w-56 rounded-full" style={{ background: "rgba(255,255,255,0.04)" }} />
            </div>
            <div className="h-5 w-20 rounded-full" style={{ background: "rgba(255,255,255,0.05)" }} />
          </div>
        ))}
      </div>
    </div>
  );
}
