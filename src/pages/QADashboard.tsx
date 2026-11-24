import React, { useState } from 'react';
import { jsPDF } from 'jspdf';
import {
  CheckCircle2,
  Download,
  Play,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import type { QAReport } from '../types.ts';
import { formatDateTimeIST } from '../lib/format.ts';

export function QADashboard({ staffToken }: { staffToken: string }) {
  const [report, setReport] = useState<QAReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runAllTests() {
    setRunning(true);
    setError(null);
    try {
      const resp = await fetch('/api/qa/run', {
        method: 'POST',
        headers: { Authorization: `Bearer ${staffToken}` },
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to execute QA test suite');
      setReport(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'QA execution error');
    } finally {
      setRunning(false);
    }
  }

  function downloadFinalQaReportPdf() {
    if (!report) return;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    let y = 48;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.text(`${report.project_name} — Final QA Execution Report`, 44, y);
    y += 20;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(`Version: ${report.version}  |  Executed: ${report.executed_at}  |  Status: ${report.final_status}`, 44, y);
    y += 20;
    doc.text(
      `Total: ${report.summary.total}  |  Passed: ${report.summary.passed}  |  Failed: ${report.summary.failed}  |  Completion: ${report.summary.completion_pct}%`,
      44,
      y
    );
    y += 26;

    doc.setFont('helvetica', 'bold');
    doc.text('End-to-End Test Cases', 44, y);
    y += 16;
    doc.setFont('helvetica', 'normal');
    for (const tc of report.test_cases) {
      doc.text(`[${tc.status.toUpperCase()}] ${tc.id} (${tc.suite}): ${tc.name} (${tc.duration_ms}ms)`, 44, y);
      y += 15;
    }
    y += 12;
    doc.setFont('helvetica', 'bold');
    doc.text('Measured API Performance Benchmarks', 44, y);
    y += 16;
    doc.setFont('helvetica', 'normal');
    for (const p of report.performance) {
      doc.text(`${p.endpoint} — Avg: ${p.avg_ms}ms | P95: ${p.p95_ms}ms (${p.status})`, 44, y);
      y += 15;
    }
    doc.save('restaurant360-qa-report.pdf');
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-zinc-200">
        <div>
          <h2 className="text-xl font-bold text-zinc-900">Automated QA &amp; Verification Lab</h2>
          <p className="text-xs text-zinc-500">
            Executes all 10 end-to-end tests, security RBAC checks, WebSocket sync, and API latency benchmarks on an isolated test database
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          {report && (
            <button
              type="button"
              onClick={downloadFinalQaReportPdf}
              className="px-4 py-2 text-xs font-medium bg-white border border-zinc-300 text-zinc-800 rounded-md inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" /> Export QA Report PDF
            </button>
          )}
          <button
            type="button"
            disabled={running}
            onClick={runAllTests}
            className="px-4 py-2 text-xs font-semibold bg-[#18181B] text-white hover:bg-[#B47B2B] rounded-md inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
          >
            {running ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Running Suite...
              </>
            ) : report ? (
              <>
                <RefreshCw className="w-3.5 h-3.5" /> Run Again
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" /> Run All Tests
              </>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg">{error}</div>
      )}

      {!report ? (
        <div className="bg-white border border-zinc-200 rounded-xl p-12 text-center">
          <ShieldCheck className="w-10 h-10 text-[#B47B2B] mx-auto" />
          <h3 className="mt-3 text-base font-semibold text-zinc-900">Ready to Run Automated QA Suite</h3>
          <p className="mt-1 text-sm text-zinc-600 max-w-lg mx-auto">
            Click <strong>Run All Tests</strong> to execute real HTTP, SQLite transaction, HMAC payment verification, RBAC security, and WebSocket realtime tests against a clean isolated test database.
          </p>
        </div>
      ) : (
        <>
          {/* Summary Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
            {[
              { label: 'Final Status', val: report.final_status },
              { label: 'Total Cases', val: String(report.summary.total) },
              { label: 'Passed', val: String(report.summary.passed) },
              { label: 'Failed', val: String(report.summary.failed) },
              { label: 'Pending / Skip', val: `${report.summary.pending} / ${report.summary.skipped}` },
              { label: 'Critical Bugs', val: String(report.summary.critical_bugs) },
              { label: 'Completion', val: `${report.summary.completion_pct}%` },
              { label: 'Duration', val: `${report.summary.total_duration_ms} ms` },
            ].map((s) => (
              <div key={s.label} className="bg-white border border-zinc-200 rounded-xl p-3.5">
                <p className="text-[11px] text-zinc-500">{s.label}</p>
                <p
                  className={`mt-1 text-base font-bold tabular-nums ${
                    s.val === 'PASS' ? 'text-emerald-700' : s.val === 'FAIL' ? 'text-red-600' : 'text-zinc-900'
                  }`}
                >
                  {s.val}
                </p>
              </div>
            ))}
          </div>

          <p className="text-xs text-zinc-500">
            Last executed: {formatDateTimeIST(report.executed_at)} · Isolated test database closed after verification.
          </p>

          {/* 10 Required End-to-End Test Cases */}
          <div className="bg-white border border-zinc-200 rounded-xl overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-50 border-b border-zinc-200 text-zinc-600">
                <tr>
                  <th className="py-3 px-4">ID</th>
                  <th className="py-3 px-4">Module</th>
                  <th className="py-3 px-4">Test Scenario &amp; Verified Outcome</th>
                  <th className="py-3 px-4 text-right">Assertions</th>
                  <th className="py-3 px-4 text-right">Time</th>
                  <th className="py-3 px-4 text-right">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {report.test_cases.map((tc) => (
                  <tr key={tc.id}>
                    <td className="py-3 px-4 font-mono font-semibold">{tc.id}</td>
                    <td className="py-3 px-4 font-medium text-zinc-700 whitespace-nowrap">{tc.suite}</td>
                    <td className="py-3 px-4">
                      <p className="font-semibold text-zinc-900">{tc.name}</p>
                      {tc.details && <p className="text-zinc-500 mt-0.5">{tc.details}</p>}
                      {tc.error && <p className="text-red-600 mt-0.5">{tc.error}</p>}
                    </td>
                    <td className="py-3 px-4 text-right tabular-nums">{tc.assertion_count}</td>
                    <td className="py-3 px-4 text-right tabular-nums">{tc.duration_ms} ms</td>
                    <td className="py-3 px-4 text-right">
                      {tc.status === 'passed' ? (
                        <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
                          <CheckCircle2 className="w-3.5 h-3.5" /> PASS
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-red-600 font-semibold">
                          <XCircle className="w-3.5 h-3.5" /> FAIL
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Performance & Security */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white border border-zinc-200 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-zinc-900 mb-3">Measured API Performance Benchmarks</h3>
              <table className="w-full text-left text-xs">
                <thead className="border-b border-zinc-200 text-zinc-500">
                  <tr>
                    <th className="py-2">Endpoint</th>
                    <th className="py-2 text-right">Avg (ms)</th>
                    <th className="py-2 text-right">P95 (ms)</th>
                    <th className="py-2 text-right">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {report.performance.map((p) => (
                    <tr key={p.endpoint}>
                      <td className="py-2 font-mono">{p.endpoint}</td>
                      <td className="py-2 text-right tabular-nums">{p.avg_ms}</td>
                      <td className="py-2 text-right tabular-nums">{p.p95_ms}</td>
                      <td className="py-2 text-right font-semibold text-emerald-700">{p.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="bg-white border border-zinc-200 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-zinc-900 mb-3">Security &amp; Responsive Readiness</h3>
              <div className="space-y-2.5 text-xs">
                {report.security_checks.map((s) => (
                  <div key={s.check} className="pb-2 border-b border-zinc-100">
                    <div className="flex items-center justify-between font-semibold">
                      <span>{s.check}</span>
                      <span className="text-emerald-700">{s.status}</span>
                    </div>
                    <p className="text-zinc-500 mt-0.5">{s.notes}</p>
                  </div>
                ))}
                {report.responsive_matrix.map((r) => (
                  <div key={r.viewport} className="flex items-center justify-between text-zinc-600">
                    <span>{r.viewport} · {r.tested_pages}</span>
                    <span className="font-semibold text-emerald-700">{r.status}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="bg-zinc-900 text-zinc-200 rounded-xl p-5 text-xs space-y-1.5">
            <p className="font-semibold text-white">Production &amp; Environment Notes</p>
            {report.production_notes.map((n) => (
              <p key={n}>· {n}</p>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
