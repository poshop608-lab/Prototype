export default function Loading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="space-y-2">
        <div className="h-8 w-40 rounded-xl" style={{ background: "rgba(255,255,255,0.06)" }} />
        <div className="h-3 w-24 rounded-full" style={{ background: "rgba(255,255,255,0.04)" }} />
      </div>
      <div className="rounded-2xl overflow-hidden" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)" }}>
        {[...Array(6)].map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-6 py-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
            <div className="w-10 h-10 rounded-xl flex-shrink-0" style={{ background: "rgba(255,255,255,0.05)" }} />
            <div className="flex-1 space-y-2">
              <div className="h-3.5 w-44 rounded-full" style={{ background: "rgba(255,255,255,0.06)" }} />
              <div className="h-3 w-60 rounded-full" style={{ background: "rgba(255,255,255,0.04)" }} />
            </div>
            <div className="h-5 w-20 rounded-full" style={{ background: "rgba(255,255,255,0.05)" }} />
          </div>
        ))}
      </div>
    </div>
  );
}
