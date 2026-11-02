/**
 * The model dropdowns (Language Model, Speech-to-Text, Text-to-Speech) show the gateway's catalog, which is built from the model
 * registry on every request. A page fetches it once, so a model added to the registry afterwards (in the Model Hub, by importing a
 * file, from another browser) would not appear until a full page reload. The gateway therefore reports a revision of the registry
 * with every state poll, and the page fetches the catalog again whenever that number differs from the one it last saw.
 */

/** The registry revision a state response reports, or null from a gateway that does not report one. */
export function catalogRevisionOf(state: unknown): number | null {
  const value = (state as { catalogRevision?: unknown } | null | undefined)?.catalogRevision;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Whether the catalog must be fetched again, given the revision last seen (null: none yet) and the newest state. */
export function catalogChanged(lastSeen: number | null, state: unknown): { reload: boolean; revision: number | null } {
  const revision = catalogRevisionOf(state);
  if (revision === null) return { reload: false, revision: lastSeen }; // an older gateway: the Hub refreshes explicitly
  return { reload: lastSeen === null || revision !== lastSeen, revision };
}
