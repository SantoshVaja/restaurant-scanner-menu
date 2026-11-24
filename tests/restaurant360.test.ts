import { describe, expect, it } from 'vitest';
import { runAutomatedQASuite } from '../server/qa-runner.ts';

describe('Restaurant 360° Full-Stack End-to-End & Security Verification', () => {
  it('passes all 10 critical end-to-end flows, RBAC security, and realtime sync checks', async () => {
    const report = await runAutomatedQASuite();
    for (const tc of report.test_cases) {
      expect(tc.status, `${tc.id} (${tc.name}) failed: ${tc.error}`).toBe('passed');
    }
    expect(report.final_status).toBe('PASS');
    expect(report.summary.failed).toBe(0);
    expect(report.summary.passed).toBe(10);
  }, 20000);
});
