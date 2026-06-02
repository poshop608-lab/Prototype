export default function Loading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="space-y-2">
        <div className="h-8 w-44 rounded-xl" style={{ background: "rgba(255,255,255,0.06)" }} />
        <div className="h-3 w-28 rounded-full" style={{ background: "rgba(255,255,255,0.04)" }} />
      </div>
      <div className="space-y-3">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="flex items-center gap-4 p-4 rounded-2xl" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
            <div className="w-10 h-10 rounded-xl flex-shrink-0" style={{ background: "rgba(255,255,255,0.05)" }} />
            <div className="flex-1 space-y-2">
              <div className="h-3.5 w-40 rounded-full" style={{ background: "rgba(255,255,255,0.06)" }} />
              <div className="h-3 w-56 rounded-full" style={{ background: "rgba(255,255,255,0.04)" }} />
            </div>
            <div className="space-y-1 text-right">
              <div className="h-4 w-16 rounded-full ml-auto" style={{ background: "rgba(255,255,255,0.06)" }} />
              <div className="h-3 w-10 rounded-full ml-auto" style={{ background: "rgba(255,255,255,0.04)" }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
