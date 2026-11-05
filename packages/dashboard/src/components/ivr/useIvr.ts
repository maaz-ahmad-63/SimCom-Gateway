'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GatewayHealthStatus } from '@sim-gateway/shared';
import { apiClient, AiStateResponse, GatewayApiError } from '../../lib/api-client';
import { addOption, IvrConfig, IvrOverview, IvrValidation, isDirty, issueWhere, localIssues, readiness, removeOption, saveProblems, updateOption } from '../../lib/ivr';
import { useAction } from '../ai/ui';

/** The gateway explains a refusal as {path, message} details; the action note shows plain reasons, so say where each one is. */
async function explained<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof GatewayApiError && error.details && error.details.length > 0) {
      throw new GatewayApiError(error.message, error.statusCode, error.code, error.details, error.details.map((d) => `${issueWhere(d.path)}: ${d.message}`));
    }
    throw error;
  }
}

const REFRESH_MS = 8000;

/**
 * Everything the IVR page needs: the gateway's saved state, a local copy of the draft the operator edits (never overwritten while it has
 * unsaved edits), health and AI readiness for the "can it run" panel, and one action per thing the page can do, each with a visible outcome.
 */
export function useIvr() {
  const [overview, setOverview] = useState<IvrOverview | null>(null);
  const [health, setHealth] = useState<GatewayHealthStatus | null>(null);
  const [ai, setAi] = useState<AiStateResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<IvrConfig | null>(null);
  const baseline = useRef<IvrConfig | null>(null);

  const [saveState, runSave] = useAction();
  const [publishState, runPublish, resetPublish] = useAction();
  const [enableState, runEnable] = useAction();
  const [resetState, runReset] = useAction();
  const [assetState, runAsset] = useAction();

  const load = useCallback(async () => {
    try {
      const [next, h, a] = await Promise.all([apiClient.getIvr(), apiClient.getHealth().catch(() => null), apiClient.getAiState().catch(() => null)]);
      setOverview(next);
      setHealth(h);
      setAi(a);
      setLoadError(null);
      // The form follows the gateway while it is untouched; unsaved edits are never replaced.
      setDraft((current) => {
        const untouched = current === null || baseline.current === null || !isDirty(baseline.current, current);
        if (!untouched) return current;
        baseline.current = next.draft;
        return next.draft;
      });
    } catch (error) {
      setLoadError((error as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  /** A response that carries the saved draft: the gateway's copy is now the baseline. */
  const adopt = useCallback((saved: IvrConfig, validation: IvrValidation, status: IvrOverview['status']) => {
    baseline.current = saved;
    setDraft(saved);
    setOverview((o) => (o ? { ...o, draft: saved, validation, status } : o));
  }, []);

  const dirty = draft !== null && baseline.current !== null && isDirty(baseline.current, draft);
  const problems = useMemo(() => (draft ? saveProblems(draft) : []), [draft]);
  /** While editing, what publishing would object to is worked out here; otherwise it is the gateway's own answer about the saved draft. */
  const issues: IvrValidation | null = useMemo(() => {
    if (!overview || !draft) return null;
    return dirty ? localIssues(draft, overview.assets) : overview.validation;
  }, [overview, draft, dirty]);
  const ready = useMemo(() => (overview ? readiness({ health, ai, runtime: overview.runtime, status: overview.status }) : null), [overview, health, ai]);

  const save = useCallback(async () => {
    if (!draft) return;
    const result = await runSave(() => explained(() => apiClient.saveIvrDraft(draft)), 'Draft saved. It is not used by calls until you publish it.');
    if (result) adopt(result.draft, result.validation, result.status);
  }, [draft, runSave, adopt]);

  const discardEdits = useCallback(() => {
    if (baseline.current) setDraft(baseline.current);
  }, []);

  const resetToPublished = useCallback(async () => {
    const result = await runReset(() => explained(() => apiClient.discardIvrDraft()), 'The saved draft was discarded. You are editing the published menu again.');
    if (result) adopt(result.draft, result.validation, result.status);
  }, [runReset, adopt]);

  /** Publishing uses the SAVED draft, so unsaved edits are saved first. If either step is refused nothing is published. */
  const publish = useCallback(async () => {
    if (!draft) return;
    const published = await runPublish(
      () =>
        explained(async () => {
          if (dirty) {
            const saved = await apiClient.saveIvrDraft(draft);
            adopt(saved.draft, saved.validation, saved.status);
          }
          return apiClient.publishIvr();
        }),
      'Published. New outgoing calls use this menu.'
    );
    if (published) await load();
  }, [draft, dirty, runPublish, adopt, load]);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      const result = await runEnable(
        () => explained(() => apiClient.setIvrEnabled(enabled)),
        enabled ? 'The IVR is on. The next outgoing call plays the menu to the person who answers.' : 'The IVR is off. Outgoing calls go straight to the normal AI handling again.'
      );
      if (result) await load();
    },
    [runEnable, load]
  );

  const upload = useCallback(
    async (file: Blob, name: string) => {
      const result = await runAsset(() => explained(() => apiClient.uploadIvrAsset(file, name)), 'Audio uploaded.');
      if (result) setOverview((o) => (o ? { ...o, assets: result.assets, audio: result.audio } : o));
      return result;
    },
    [runAsset]
  );

  const removeAsset = useCallback(
    async (id: string) => {
      const result = await runAsset(() => explained(() => apiClient.deleteIvrAsset(id)), 'Audio file deleted.');
      if (result) setOverview((o) => (o ? { ...o, assets: result.assets, audio: result.audio } : o));
    },
    [runAsset]
  );

  return {
    overview,
    draft,
    setDraft,
    dirty,
    problems,
    issues,
    ready,
    loadError,
    reload: load,
    edit: {
      addOption: () => draft && setDraft(addOption(draft)),
      removeOption: (i: number) => draft && setDraft(removeOption(draft, i)),
      updateOption: (i: number, patch: Parameters<typeof updateOption>[2]) => draft && setDraft(updateOption(draft, i, patch)),
    },
    save,
    discardEdits,
    resetToPublished,
    publish,
    setEnabled,
    upload,
    removeAsset,
    saveState,
    publishState,
    resetPublish,
    enableState,
    resetState,
    assetState,
  };
}
