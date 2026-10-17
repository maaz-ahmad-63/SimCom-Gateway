/**
 * Idle-silence handling, ported from labs-sizh-voicely services/llm/idle_manager.py (IdleManager) with
 * its follow-up and goodbye lines from services/llm/llm_config.py.
 *
 * Behaviour kept from the source: after the caller goes quiet the agent waits 15 s and asks whether they
 * are still there, waits 9 s and asks again, waits 8 s more, says goodbye and disconnects. Any real
 * transcription resets the count, the timer pauses while someone is speaking, and a stopped manager
 * never fires. Adaptation: the disconnect is a callback, because ending the call stays a decision the
 * gateway makes (it only hangs up when AI_ALLOW_AGENT_HANGUP is true).
 */

export const FOLLOWUP_MESSAGES: Record<string, string[]> = {
  en: [
    'Hello? Are you still there?',
    'Are you still with me?',
    'Is anyone there?',
    'Just checking in—are you still connected?',
    "Let me know if you're still there.",
    "I'm here whenever you're ready.",
    'Please let me know if you can hear me.',
    'Still waiting for your response.',
    'Are you able to reply right now?',
  ],
  ar: [
    'مرحباً؟ هل ما زلت هناك؟',
    'هل ما زلت معي؟',
    'هل يوجد أحد هناك؟',
    'فقط أتحقق - هل ما زلت متصلاً؟',
    'أخبرني إذا كنت ما زلت هناك.',
    'أنا هنا عندما تكون مستعداً.',
    'من فضلك أخبرني إذا كنت تسمعني.',
    'ما زلت أنتظر ردك.',
    'هل يمكنك الرد الآن؟',
  ],
  hi: [
    'क्या आप अभी भी वहाँ हैं?',
    'क्या आप अभी भी मेरे साथ हैं?',
    'क्या कोई वहाँ है?',
    'क्या आप अभी भी जुड़े हुए हैं?',
    'कृपया मुझे बताइए अगर आप अभी भी वहाँ हैं।',
    'मैं यहीं हूँ जब आप तैयार हों।',
    'कृपया मुझे बताइए अगर आप मुझे सुन सकते हैं।',
    'क्या आप अभी जवाब दे सकते हैं?',
  ],
};

export const DISCONNECT_MESSAGES: Record<string, string> = {
  en: "I didn't get a response, so I'm disconnecting now. Goodbye.",
  ar: 'لم أتلق رداً، لذا سأقطع الاتصال الآن. وداعاً.',
  hi: 'मुझे कोई जवाब नहीं मिला, इसलिए मैं अब डिस्कनेक्ट कर रही हूँ। अलविदा।',
};

/** Source constants: FOLLOWUP_AFTER, HANGUP_AFTER_1, HANGUP_AFTER_2 (seconds). */
export const DEFAULT_IDLE_WAITS_MS: readonly [number, number, number] = [15_000, 9_000, 8_000];

/** Source lookup: messages by the language column, English when the language has none. */
export function idleMessages(language: string): { followups: string[]; goodbye: string } {
  const base = language.split('-')[0].toLowerCase();
  return {
    followups: FOLLOWUP_MESSAGES[base] ?? FOLLOWUP_MESSAGES.en,
    goodbye: DISCONNECT_MESSAGES[base] ?? DISCONNECT_MESSAGES.en,
  };
}

export interface IdleManagerOptions {
  followups: string[];
  goodbye: string;
  /** Speak a line. A rejection stops the manager (the session is gone). */
  say: (text: string) => Promise<unknown>;
  /** Called after the goodbye was spoken. */
  disconnect: () => Promise<void> | void;
  waitsMs?: readonly [number, number, number];
  random?: () => number;
}

export class IdleManager {
  private readonly waits: readonly [number, number, number];
  private readonly random: () => number;
  private timer: NodeJS.Timeout | null = null;
  private enabled = false;
  idleCount = 0;

  constructor(private readonly options: IdleManagerOptions) {
    this.waits = options.waitsMs ?? DEFAULT_IDLE_WAITS_MS;
    this.random = options.random ?? Math.random;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Allow the timer to run (after the greeting has been sent). */
  enable(): void {
    this.enabled = true;
  }

  /** Start or restart the timer from the current stage. */
  start(): void {
    if (!this.enabled) return;
    this.cancel();
    const wait = this.waits[Math.min(this.idleCount, this.waits.length - 1)];
    this.timer = setTimeout(() => void this.fire(), wait);
    this.timer.unref?.();
  }

  /** While someone is speaking. */
  pause(): void {
    this.cancel();
  }

  /** A real transcription arrived: the caller is there. */
  resetOnUserSpeech(): void {
    this.idleCount = 0;
    this.start();
  }

  /** Permanently: on END_CALL, hang-up, mode change or detach. */
  stop(): void {
    this.enabled = false;
    this.cancel();
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async fire(): Promise<void> {
    this.timer = null;
    if (!this.enabled) return;
    this.idleCount++;
    try {
      if (this.idleCount <= 2) {
        const pool = this.options.followups;
        await this.options.say(pool[Math.floor(this.random() * pool.length)] ?? pool[0]);
        // The turn that speaks this line ends with a turn event, which restarts the timer for the next stage.
        return;
      }
      await this.options.say(this.options.goodbye);
      if (!this.enabled) return;
      this.enabled = false;
      await this.options.disconnect();
    } catch {
      // The session is gone or closing: nothing more to say.
      this.stop();
    }
  }
}
