'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../lib/api-client';
import { setupSteps, setupSummary, SetupStep } from '../../lib/setup';
import { SetupList } from '../../components/ops/SetupList';
import { Badge, Button, Card } from '../../components/ai/ui';

export default function SetupPage() {
  const [steps, setSteps] = useState<SetupStep[]>(() => setupSteps({ reachable: false, health: null, network: null, hardware: null, ai: null }));
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    setBusy(true);
    const [health, network, hardware, ai] = await Promise.allSettled([apiClient.getOpsHealth(true), apiClient.getOpsNetwork(), apiClient.getHardwareStatus(), apiClient.getAiState()]);
    const h = health.status === 'fulfilled' ? health.value : null;
    const hw = hardware.status === 'fulfilled' ? hardware.value : null;
    const a = ai.status === 'fulfilled' ? ai.value.readiness : null;
    setSteps(
      setupSteps({
        reachable: h !== null,
        health: h,
        network: network.status === 'fulfilled' ? network.value.reading : null,
        hardware: hw ? { simulated: hw.gateway.isSimulated, atPort: hw.modem.configuredAtPort, audioPort: hw.modem.configuredAudioPort, discoveryOk: hw.discovery?.ok ?? null } : null,
        ai: a ? { ok: a.ok, blockers: a.blockers, checks: [] } : null,
      })
    );
    setBusy(false);
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const summary = setupSummary(steps);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold text-white">Setup</h1>
        <p className="text-xs text-slate-400">A checklist for the first start. Nothing here changes a setting or places a call.</p>
      </div>
      <Card
        title="Is everything ready?"
        actions={
          <Button onClick={() => void check()} busy={busy}>
            Check again
          </Button>
        }
      >
        <Badge tone={summary.ready ? 'good' : summary.label === 'Checking…' ? 'neutral' : 'bad'}>{summary.label}</Badge>
        <SetupList steps={steps} />
      </Card>
    </div>
  );
}
