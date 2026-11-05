/** One problem with a configuration or an asset, with where it is (a dotted path such as `options[1].action.assetId`). */
export interface IvrIssue {
  path: string;
  message: string;
}

export type IvrErrorCode =
  | 'invalid_config' // the document does not match the model, or publishing was refused because it is not complete
  | 'invalid_asset' // the audio file is not acceptable
  | 'asset_not_found'
  | 'asset_in_use' // referenced by the draft or the published configuration
  | 'asset_unavailable' // referenced, but missing, damaged or in a format the gateway no longer accepts
  | 'not_published' // there is nothing to enable or to snapshot yet
  | 'storage_error'
  | 'invalid_tts_request' // the text, voice model or voice for a generated announcement is not acceptable
  | 'tts_unavailable' // the chosen voice model cannot be used right now (switched off, no key, not ported)
  | 'tts_failed' // the provider could not produce the audio
  | 'tts_busy'; // another generation is still running

/** `status` is the HTTP status the API layer should answer with (the routes come later). */
export class IvrError extends Error {
  constructor(
    readonly code: IvrErrorCode,
    message: string,
    readonly status: number = 422,
    readonly issues: IvrIssue[] = []
  ) {
    super(message);
    this.name = 'IvrError';
  }
}
