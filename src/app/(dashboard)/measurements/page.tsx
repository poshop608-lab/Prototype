import { createServerClient } from "@/lib/supabase/server";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { Ruler } from "lucide-react";

export default async function MeasurementsPage() {
  const supabase = createServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const { data: measurements } = await supabase
    .from("measurements")
    .select(`
      *,
      scan:scans(
        scan_id, size, status, batch_id, created_at,
        shoe_model:shoe_models(name, brand)
      )
    `)
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-sv-white">Measurements</h1>
        <p className="text-sv-gray-400 text-sm mt-1">
          {measurements?.length || 0} measurement records
        </p>
      </div>

      {!measurements?.length ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Ruler className="w-10 h-10 text-sv-gray-700 mx-auto mb-3" />
            <p className="text-sv-gray-400">No measurements yet</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {measurements.map((m) => {
            const scan = m.scan as any;
            return (
              <Link key={m.id} href={`/measurements/${scan?.id || m.scan_id}`}>
                <Card className="hover:border-sv-gray-600 transition-colors cursor-pointer">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-lg bg-sv-gray-800 flex items-center justify-center flex-shrink-0">
                        <Ruler className="w-5 h-5 text-sv-gray-400" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sv-white font-medium text-sm">
                            {scan?.shoe_model?.brand} {scan?.shoe_model?.name}
                          </span>
                          <Badge variant="success" className="text-[10px]">
                            {m.overall_accuracy?.toFixed(0)}% accuracy
                          </Badge>
                        </div>
                        <div className="text-sv-gray-500 text-xs mt-0.5 flex gap-3 flex-wrap">
                          <span>EU {scan?.size}</span>
                          <span>{scan?.scan_id}</span>
                          <span>{formatDate(m.created_at)}</span>
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="text-sv-white text-sm font-medium tabular-nums">
                          {m.shoe_length_mm?.toFixed(0)} mm
                        </div>
                        <div className="text-sv-gray-500 text-xs">length</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
