// Client-side PDF export for scan history.
// Uses jsPDF + jspdf-autotable. No server required.

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { Scan } from "@/types/database";

export type PdfFilter =
  | { type: "all" }
  | { type: "last30" }
  | { type: "last7days" }
  | { type: "last30days" }
  | { type: "custom"; from: string; to: string }; // ISO date strings

type ScanWithWorker = Scan & { worker?: { full_name: string | null; email: string } | null };

function applyFilter(scans: ScanWithWorker[], filter: PdfFilter): ScanWithWorker[] {
  if (filter.type === "all") return scans;
  if (filter.type === "last30") return scans.slice(0, 30);

  const now = new Date();
  if (filter.type === "last7days") {
    const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return scans.filter(s => new Date(s.created_at) >= cutoff);
  }
  if (filter.type === "last30days") {
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return scans.filter(s => new Date(s.created_at) >= cutoff);
  }
  if (filter.type === "custom") {
    const from = new Date(filter.from);
    const to   = new Date(filter.to);
    to.setHours(23, 59, 59, 999);
    return scans.filter(s => {
      const d = new Date(s.created_at);
      return d >= from && d <= to;
    });
  }
  return scans;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function filterLabel(filter: PdfFilter): string {
  if (filter.type === "all")       return "All records";
  if (filter.type === "last30")    return "Last 30 records";
  if (filter.type === "last7days") return "Last 7 days";
  if (filter.type === "last30days")return "Last 30 days";
  if (filter.type === "custom")    return `${filter.from} to ${filter.to}`;
  return "";
}

export function exportScansPdf(scans: ScanWithWorker[], filter: PdfFilter): void {
  const filtered = applyFilter(scans, filter);

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const now   = new Date().toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  // ── Header ──────────────────────────────────────────────────────────────
  doc.setFillColor(10, 10, 10);
  doc.rect(0, 0, pageW, 22, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(6, 182, 212);
  doc.text("StrideVision", 14, 10);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(150, 150, 150);
  doc.text("Shoe Heel QC Report", 14, 16);
  doc.text(`Exported: ${now}`, pageW - 14, 10, { align: "right" });
  doc.text(`Filter: ${filterLabel(filter)}`, pageW - 14, 16, { align: "right" });

  // ── Summary bar ─────────────────────────────────────────────────────────
  const passCount = filtered.filter(s => s.passed === true).length;
  const failCount = filtered.filter(s => s.passed === false).length;

  doc.setFillColor(20, 20, 20);
  doc.rect(0, 22, pageW, 14, "F");

  const stats = [
    { label: "Total Scans", value: String(filtered.length), color: [255, 255, 255] as [number,number,number] },
    { label: "Passed",      value: String(passCount),       color: [34, 197, 94]   as [number,number,number] },
    { label: "Rejected",    value: String(failCount),       color: [239, 68, 68]   as [number,number,number] },
    { label: "Pass Rate",   value: filtered.length ? `${Math.round(passCount / filtered.length * 100)}%` : "—", color: [6, 182, 212] as [number,number,number] },
  ];

  const colW = pageW / stats.length;
  stats.forEach((s, i) => {
    const cx = colW * i + colW / 2;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(...s.color);
    doc.text(s.value, cx, 30, { align: "center" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(120, 120, 120);
    doc.text(s.label, cx, 34, { align: "center" });
  });

  // ── Table ────────────────────────────────────────────────────────────────
  autoTable(doc, {
    startY: 40,
    head: [["#", "Scan ID", "Date / Time", "L (mm)", "R (mm)", "Δ (mm)", "Result", "Worker"]],
    body: filtered.map((s, i) => [
      String(i + 1),
      s.scan_id,
      fmtDate(s.created_at),
      s.left_height_mm  != null ? String(s.left_height_mm)  : "—",
      s.right_height_mm != null ? String(s.right_height_mm) : "—",
      s.height_diff_mm  != null ? String(s.height_diff_mm)  : "—",
      s.passed === true ? "PASS" : s.passed === false ? "FAIL" : "—",
      s.worker?.full_name || s.worker?.email || "—",
    ]),
    styles: {
      fontSize: 8,
      cellPadding: 3,
      textColor: [220, 220, 220],
      fillColor: [18, 18, 18],
      lineColor: [40, 40, 40],
      lineWidth: 0.2,
    },
    headStyles: {
      fillColor: [6, 182, 212],
      textColor: [0, 0, 0],
      fontStyle: "bold",
      fontSize: 8,
    },
    alternateRowStyles: {
      fillColor: [24, 24, 24],
    },
    didParseCell(data) {
      if (data.column.index === 6 && data.section === "body") {
        const val = data.cell.raw as string;
        if (val === "PASS") data.cell.styles.textColor = [34, 197, 94];
        if (val === "FAIL") data.cell.styles.textColor = [239, 68, 68];
      }
    },
    columnStyles: {
      0: { cellWidth: 8 },
      1: { cellWidth: 30 },
      2: { cellWidth: 38 },
      3: { cellWidth: 18, halign: "right" },
      4: { cellWidth: 18, halign: "right" },
      5: { cellWidth: 18, halign: "right" },
      6: { cellWidth: 18, halign: "center", fontStyle: "bold" },
      7: { cellWidth: "auto" },
    },
    margin: { left: 14, right: 14 },
  });

  // ── Footer on every page ─────────────────────────────────────────────────
  const pageCount = (doc as unknown as { internal: { getNumberOfPages(): number } }).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    const h = doc.internal.pageSize.getHeight();
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(80, 80, 80);
    doc.text("StrideVision — Confidential QC Report", 14, h - 6);
    doc.text(`Page ${p} of ${pageCount}`, pageW - 14, h - 6, { align: "right" });
  }

  const slug = filter.type === "custom"
    ? `${filter.from}_${filter.to}`
    : filter.type;
  doc.save(`stridevision-report-${slug}-${Date.now()}.pdf`);
}
