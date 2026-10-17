'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '../../lib/api-client';
import { buildSettingsPatch, draftFromSettings, isDirty, SettingsDraft, validateDraft } from '../../lib/ai-settings-form';
import { useAi } from '../../lib/context/AiContext';
import { useAction } from './ui';

/**
 * A local, editable copy of the gateway's saved AI settings. Nothing is sent until Save; Cancel
 * restores what the gateway has. When the saved settings change underneath an untouched form
 * (another tab, another operator) the form follows them; a form with unsaved edits is never overwritten.
 */
export function useSettingsDraft() {
  const { state, catalog, refresh } = useAi();
  const saved = useMemo(() => (state ? draftFromSettings(state.settings) : null), [state]);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const baseline = useRef<SettingsDraft | null>(null);
  const [action, run, reset] = useAction();

  useEffect(() => {
    if (!saved) return;
    const untouched = !draft || !baseline.current || !isDirty(baseline.current, draft);
    if (untouched) {
      setDraft(saved);
      baseline.current = saved;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const dirty = !!(draft && baseline.current && isDirty(baseline.current, draft));
  const problems = useMemo(() => (draft && catalog && dirty ? validateDraft(draft, catalog) : []), [draft, catalog, dirty]);

  const save = useCallback(async () => {
    if (!draft || !baseline.current) return;
    const patch = buildSettingsPatch(baseline.current, draft);
    if (Object.keys(patch).length === 0) return;
    const result = await run(() => apiClient.saveAiSettings(patch), 'Saved. Applies from the next call; a call in progress keeps its current settings.');
    if (result) {
      baseline.current = null; // let the refreshed server copy replace the form
      setDraft(null);
      await refresh();
    }
  }, [draft, run, refresh]);

  const cancel = useCallback(() => {
    if (baseline.current) setDraft(baseline.current);
    reset();
  }, [reset]);

  return { draft, setDraft, dirty, problems, action, save, cancel, catalog, state };
}
